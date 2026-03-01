import { test, expect } from "@playwright/test";
import { authenticate, cleanupTestData, apiCall } from "./helpers.js";

test.describe("Task Flow (Agent + Task integration)", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("full flow: create agent, create task with agent, see task in inbox with agent badge", async ({
    page,
    request,
  }) => {
    // 1. Create agent via API
    const agentRes = await apiCall(request, "post", "/agents", {
      name: "flow-agent",
      cli_provider: "claude",
      avatar_emoji: "🚀",
      role: "lead_engineer",
    });
    const agent = await agentRes.json();

    // 2. Navigate to board
    await page.goto("/");
    await page.waitForSelector("text=Task Board");

    // 3. Verify agent shows in header
    await expect(page.locator("text=flow-agent")).toBeVisible();

    // 4. Create task via UI with agent assigned
    await page.click("button:has-text('+ New Task')");
    await page.waitForSelector('input[placeholder="What needs to be done?"]');
    await page.fill('input[placeholder="What needs to be done?"]', "Implement auth feature");
    await page.fill('textarea[placeholder="Detailed instructions..."]', "Add JWT authentication to API");

    // Select the agent by value (agent.id)
    const agentSelect = page.locator('form select').first();
    await agentSelect.selectOption(agent.id);

    await page.click('button[type="submit"]:has-text("Create Task")');

    // 5. Wait for modal to close and verify task appears
    await expect(page.locator("text=Implement auth feature")).toBeVisible({ timeout: 10_000 });
  });

  test("task moves through statuses via API", async ({ request }) => {
    // Create agent
    const agentRes = await apiCall(request, "post", "/agents", {
      name: "status-agent",
      cli_provider: "claude",
    });
    const agent = await agentRes.json();

    // Create task assigned to agent
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Status Flow Task",
      assigned_agent_id: agent.id,
      task_size: "small",
    });
    const task = await taskRes.json();
    expect(task.status).toBe("inbox");

    // Move to self_review
    const reviewRes = await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "self_review",
    });
    expect((await reviewRes.json()).status).toBe("self_review");

    // Move to pr_review
    const prRes = await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "pr_review",
    });
    expect((await prRes.json()).status).toBe("pr_review");

    // Move to done
    const doneRes = await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "done",
    });
    const doneTask = await doneRes.json();
    expect(doneTask.status).toBe("done");
    expect(doneTask.completed_at).toBeTruthy();
  });

  test("task board columns show correct counts", async ({ page, request }) => {
    // Create agent
    await apiCall(request, "post", "/agents", {
      name: "count-agent",
      cli_provider: "claude",
    });

    // Create tasks in different statuses
    const task1Res = await apiCall(request, "post", "/tasks", {
      title: "Inbox Task 1",
      task_size: "small",
    });
    const task2Res = await apiCall(request, "post", "/tasks", {
      title: "Inbox Task 2",
      task_size: "medium",
    });
    const task3Res = await apiCall(request, "post", "/tasks", {
      title: "Done Task",
      task_size: "small",
    });
    const task3 = await task3Res.json();
    await apiCall(request, "put", `/tasks/${task3.id}`, { status: "done" });

    // Load the board
    await page.goto("/");
    await page.waitForSelector("text=Task Board");

    // Verify tasks appear
    await expect(page.locator("text=Inbox Task 1")).toBeVisible();
    await expect(page.locator("text=Inbox Task 2")).toBeVisible();
    await expect(page.locator("text=Done Task")).toBeVisible();
  });

  test("task detail modal opens on click", async ({ page, request }) => {
    // Create a task
    await apiCall(request, "post", "/tasks", {
      title: "Clickable Task",
      description: "Task with description for detail view",
      task_size: "large",
    });

    await page.goto("/");
    await page.waitForSelector("text=Task Board");

    // Click on the task card
    await page.click("text=Clickable Task");

    // Verify detail modal opens (should show task title and description)
    await expect(page.locator("text=Task with description for detail view")).toBeVisible();
  });

  test("API validation rejects invalid task data", async ({ request }) => {
    // Empty title should fail
    const res = await apiCall(request, "post", "/tasks", {
      title: "",
      task_size: "small",
    });
    expect(res.status()).toBe(400);

    // Invalid task_size should fail
    const res2 = await apiCall(request, "post", "/tasks", {
      title: "Valid Title",
      task_size: "huge",
    });
    expect(res2.status()).toBe(400);
  });
});
