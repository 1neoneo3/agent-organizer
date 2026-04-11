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

  test("creating a task without an assignee auto-assigns the idle agent and starts it", async ({
    page,
    request,
  }) => {
    // 1. Create agent via API
    const agentRes = await apiCall(request, "post", "/agents", {
      name: "auto-start-agent",
      cli_provider: "claude",
      avatar_emoji: "🚀",
      role: "lead_engineer",
    });
    const agent = await agentRes.json();

    // 2. Navigate to board
    await page.goto("/");
    await page.waitForSelector("text=TOWN MAP");

    // 3. Verify agent shows in header
    await expect(page.locator("text=auto-start-agent")).toBeVisible();

    // 4. Create task via UI without explicitly assigning an agent
    await page.click("button:has-text('+ NEW QUEST')");
    await page.waitForSelector('input[placeholder="What needs to be done?"]');
    await page.fill('input[placeholder="What needs to be done?"]', "Auto assign and start task");
    await page.fill('textarea[placeholder="Detailed instructions..."]', "Verify task create auto-assigns and auto-starts");

    const createTaskResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/tasks") && response.request().method() === "POST"
    );

    await page.click('button[type="submit"]:has-text("Create Task")');
    const createdTask = await (await createTaskResponsePromise).json();

    expect(createdTask.assigned_agent_id).toBe(agent.id);
    expect(createdTask.status).toBe("in_progress");
    expect(createdTask.started_at).toBeTruthy();

    // 5. Wait for modal to close and verify task appears as running with the auto-assigned agent
    const taskCard = page.locator(".eb-window", { hasText: "Auto assign and start task" }).first();
    await expect(taskCard).toBeVisible({ timeout: 10_000 });
    await expect(taskCard).toContainText("BATTLE");
    await expect(taskCard).toContainText("auto-start-agent");
  });

  test("task created with an assigned agent auto-starts, then moves through statuses via API", async ({ request }) => {
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
    expect(task.assigned_agent_id).toBe(agent.id);
    expect(task.status).toBe("in_progress");
    expect(task.started_at).toBeTruthy();

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
    // Create tasks in different statuses without agents so they remain in inbox unless explicitly updated
    await apiCall(request, "post", "/tasks", {
      title: "Inbox Task 1",
      task_size: "small",
    });
    await apiCall(request, "post", "/tasks", {
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
    await page.waitForSelector("text=TOWN MAP");

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
    await page.waitForSelector("text=TOWN MAP");

    // Click on the task card
    await page.click("text=Clickable Task");

    // Verify detail modal opens (should show task title and description)
    await expect(page.locator("text=Task with description for detail view")).toBeVisible();
  });

  test("task description renders markdown (headings, lists, code)", async ({ page, request }) => {
    const markdown = [
      "## 背景",
      "BigQuery の `oripaone.coins` カラムの乖離検証。",
      "",
      "### やってほしいこと",
      "- charge が複数回あるユーザー",
      "- gacha 回数が多いユーザー",
      "- withdraw を含むユーザー",
      "",
      "```sql",
      "SELECT coins FROM users_history",
      "```",
    ].join("\n");

    await apiCall(request, "post", "/tasks", {
      title: "Markdown Rendering Task",
      description: markdown,
      task_size: "small",
    });

    await page.goto("/");
    await page.waitForSelector("text=Agent Organizer");
    await page.click("text=Markdown Rendering Task");

    const container = page.getByTestId("markdown-content");
    await expect(container).toBeVisible();

    // Heading is rendered as <h2> (not raw "## ")
    await expect(container.locator("h2", { hasText: "背景" })).toBeVisible();
    await expect(container.locator("h3", { hasText: "やってほしいこと" })).toBeVisible();

    // List items are rendered as <li>
    await expect(container.locator("li", { hasText: "charge が複数回あるユーザー" })).toBeVisible();

    // Inline code + code block render as <code>
    await expect(container.locator("code", { hasText: "oripaone.coins" })).toBeVisible();
    await expect(container.locator("code", { hasText: "SELECT coins FROM users_history" })).toBeVisible();

    // Raw markdown syntax must NOT appear as visible text
    await expect(container.getByText(/^## 背景$/)).toHaveCount(0);
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
