import { test, expect } from "@playwright/test";
import { authenticate, cleanupTestData, apiCall } from "./helpers.js";

test.describe("Refinement Feedback (E2E)", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("feedback on refinement task records exactly 2 stage transitions via API", async ({ request }) => {
    const agentRes = await apiCall(request, "post", "/agents", {
      name: "refinement-e2e-agent",
      cli_provider: "claude",
      role: "lead_engineer",
    });
    const agent = await agentRes.json();
    expect(agent.id).toBeTruthy();

    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Refinement Feedback E2E",
      description: "Test refinement feedback stage transitions",
      task_size: "medium",
    });
    const task = await taskRes.json();
    expect(task.id).toBeTruthy();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
      assigned_agent_id: agent.id,
    });

    const feedbackRes = await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Please revise the refinement plan to include error handling.",
    });
    expect(feedbackRes.ok()).toBeTruthy();
    const feedbackBody = await feedbackRes.json();
    expect(feedbackBody.sent).toBe(true);

    const logsRes = await apiCall(request, "get", `/tasks/${task.id}/logs`);
    const logs = await logsRes.json() as Array<{ message: string }>;
    const transitions = logs.filter((log) => log.message.startsWith("__STAGE_TRANSITION__:"));

    expect(transitions).toHaveLength(2);
    expect(transitions[0].message).toBe("__STAGE_TRANSITION__:refinement→inbox");
    expect(transitions[1].message).toBe("__STAGE_TRANSITION__:inbox→refinement");
  });

  test("feedback on refinement task sets revision-requested timestamp", async ({ request }) => {
    const agentRes = await apiCall(request, "post", "/agents", {
      name: "revision-ts-agent",
      cli_provider: "claude",
      role: "lead_engineer",
    });
    const agent = await agentRes.json();

    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Revision Timestamp E2E",
      task_size: "small",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
      assigned_agent_id: agent.id,
    });

    const beforeFeedback = Date.now();
    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Tighten the scope.",
    });

    const updatedRes = await apiCall(request, "get", `/tasks/${task.id}`);
    const updated = await updatedRes.json();
    expect(updated.refinement_revision_requested_at).toBeTruthy();
    expect(Number(updated.refinement_revision_requested_at)).toBeGreaterThanOrEqual(beforeFeedback);
    expect(updated.refinement_revision_completed_at).toBeFalsy();
  });

  test("feedback on non-refinement task does not produce refinement transitions", async ({ request }) => {
    const agentRes = await apiCall(request, "post", "/agents", {
      name: "non-refinement-agent",
      cli_provider: "claude",
      role: "lead_engineer",
    });
    const agent = await agentRes.json();

    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Non-Refinement Feedback E2E",
      description: "This task is in pr_review, not refinement",
      assigned_agent_id: agent.id,
      task_size: "small",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "pr_review",
    });

    const feedbackRes = await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Fix the edge case in the handler.",
    });
    expect(feedbackRes.ok()).toBeTruthy();

    const logsRes = await apiCall(request, "get", `/tasks/${task.id}/logs`);
    const logs = await logsRes.json() as Array<{ message: string }>;
    const refinementTransitions = logs.filter(
      (log) => log.message.includes("refinement→inbox") || log.message.includes("inbox→refinement"),
    );
    expect(refinementTransitions).toHaveLength(0);
  });

  test("task detail modal shows CEO Feedback log entry after feedback", async ({ page, request }) => {
    const agentRes = await apiCall(request, "post", "/agents", {
      name: "ui-feedback-agent",
      cli_provider: "claude",
      role: "lead_engineer",
    });
    const agent = await agentRes.json();

    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "UI Feedback Visibility",
      description: "Verify feedback shows in activity",
      assigned_agent_id: agent.id,
      task_size: "medium",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });

    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Add acceptance criteria for error states.",
    });

    await page.goto("/");
    await page.waitForSelector("text=TOWN MAP");
    await page.click("text=UI Feedback Visibility");

    await expect(
      page.locator("text=Add acceptance criteria for error states."),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("multiple rapid feedbacks on refinement task produce exactly one pair per feedback", async ({ request }) => {
    // Use an unassigned task to avoid spawnAgent race conditions in E2E.
    // Without an agent, feedback takes the running-process path (records inbox round-trip)
    // then falls through to idle-agent path where !agentId returns early.
    // Status stays refinement between calls → deterministic transition count.
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Rapid Feedback E2E",
      task_size: "medium",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });

    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "First revision request.",
    });
    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Second revision request.",
    });
    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Third revision request.",
    });

    const logsRes = await apiCall(request, "get", `/tasks/${task.id}/logs`);
    const logs = await logsRes.json() as Array<{ message: string }>;
    const transitions = logs.filter((log) => log.message.startsWith("__STAGE_TRANSITION__:"));

    expect(transitions.length).toBe(6);
    for (let i = 0; i < transitions.length; i += 2) {
      expect(transitions[i].message).toBe("__STAGE_TRANSITION__:refinement→inbox");
      expect(transitions[i + 1].message).toBe("__STAGE_TRANSITION__:inbox→refinement");
    }

    const feedbackLogs = logs.filter((log) => log.message.startsWith("[CEO Feedback]"));
    expect(feedbackLogs).toHaveLength(3);
  });
});
