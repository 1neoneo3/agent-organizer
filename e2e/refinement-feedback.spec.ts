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

  test("feedback on unassigned refinement task records exactly 2 stage transitions via terminal API", async ({ request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Refinement Feedback E2E",
      description: "Test refinement feedback stage transitions",
      task_size: "medium",
    });
    const task = await taskRes.json();
    expect(task.id).toBeTruthy();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });

    const beforeTerminalRes = await apiCall(request, "get", `/tasks/${task.id}/terminal`);
    expect(beforeTerminalRes.ok()).toBeTruthy();
    const beforeTerminal = await beforeTerminalRes.json() as {
      stage_transitions: Array<{ from: string; to: string }>;
    };

    const feedbackRes = await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Please revise the refinement plan to include error handling.",
    });
    expect(feedbackRes.ok()).toBeTruthy();
    const feedbackBody = await feedbackRes.json();
    expect(feedbackBody.sent).toBe(true);
    expect(feedbackBody.restarted).toBe(false);

    const terminalRes = await apiCall(request, "get", `/tasks/${task.id}/terminal`);
    expect(terminalRes.ok()).toBeTruthy();
    const terminal = await terminalRes.json() as {
      stage_transitions: Array<{ from: string; to: string }>;
      task_logs: Array<{ message: string }>;
    };

    const feedbackTransitions = terminal.stage_transitions.slice(beforeTerminal.stage_transitions.length);
    expect(feedbackTransitions).toHaveLength(2);
    expect(feedbackTransitions[0]).toMatchObject({ from: "refinement", to: "inbox" });
    expect(feedbackTransitions[1]).toMatchObject({ from: "inbox", to: "refinement" });
    expect(
      terminal.task_logs.filter((log) => log.message.includes("Returning to inbox before re-entering refinement.")),
    ).toHaveLength(1);
  });

  test("feedback on unassigned refinement task sets revision-requested timestamp", async ({ request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Revision Timestamp E2E",
      task_size: "small",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
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
    expect(updated.status).toBe("refinement");
  });

  test("feedback on non-refinement task does not produce refinement transitions", async ({ request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Non-Refinement Feedback E2E",
      description: "This task is in pr_review, not refinement",
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

  test("feedback is exposed in task logs after submission", async ({ request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "UI Feedback Visibility",
      description: "Verify feedback shows in activity",
      task_size: "medium",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "pr_review",
    });

    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Add acceptance criteria for error states.",
    });

    const logsRes = await apiCall(request, "get", `/tasks/${task.id}/logs`);
    expect(logsRes.ok()).toBeTruthy();
    const logs = await logsRes.json() as Array<{ message: string }>;
    expect(
      logs.some((log) => log.message === "[CEO Feedback] Add acceptance criteria for error states."),
    ).toBe(true);
  });

  test("whitespace-only feedback is rejected via API", async ({ request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Whitespace Feedback",
      task_size: "small",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });

    const feedbackRes = await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "   ",
    });
    expect(feedbackRes.status()).toBe(400);
  });

  test("multiple rapid feedbacks on refinement task produce exactly one pair per feedback", async ({ request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Rapid Feedback E2E",
      task_size: "medium",
    });
    const task = await taskRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });

    const beforeTerminalRes = await apiCall(request, "get", `/tasks/${task.id}/terminal`);
    const beforeTerminal = await beforeTerminalRes.json() as {
      stage_transitions: Array<{ from: string; to: string }>;
    };

    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "First revision request.",
    });
    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Second revision request.",
    });
    await apiCall(request, "post", `/tasks/${task.id}/feedback`, {
      content: "Third revision request.",
    });

    const taskDetailRes = await apiCall(request, "get", `/tasks/${task.id}`);
    const updatedTask = await taskDetailRes.json();
    expect(updatedTask.status).toBe("refinement");

    const terminalRes = await apiCall(request, "get", `/tasks/${task.id}/terminal`);
    const terminal = await terminalRes.json() as {
      stage_transitions: Array<{ from: string; to: string }>;
      task_logs: Array<{ message: string }>;
    };

    const feedbackTransitions = terminal.stage_transitions.slice(beforeTerminal.stage_transitions.length);
    expect(feedbackTransitions.length).toBe(6);
    for (let i = 0; i < feedbackTransitions.length; i += 2) {
      expect(feedbackTransitions[i]).toMatchObject({ from: "refinement", to: "inbox" });
      expect(feedbackTransitions[i + 1]).toMatchObject({ from: "inbox", to: "refinement" });
    }

    const feedbackLogs = terminal.task_logs.filter((log) => log.message.startsWith("[CEO Feedback]"));
    expect(feedbackLogs).toHaveLength(3);
    const reviseLogs = terminal.task_logs.filter(
      (log) => log.message.includes("Returning to inbox before re-entering refinement."),
    );
    expect(reviseLogs).toHaveLength(3);
  });
});
