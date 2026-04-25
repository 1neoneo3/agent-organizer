import { test, expect } from "@playwright/test";
import {
  authenticate,
  cleanupTestData,
  apiCall,
  TASK_TITLE_PLACEHOLDER,
  TASK_DESCRIPTION_PLACEHOLDER,
} from "./helpers.js";

test.describe("Task CRUD", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("create a task via UI and verify it appears in Inbox", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=TOWN MAP");

    // Click "+ NEW QUEST" button
    await page.click("button:has-text('+ NEW QUEST')");

    // Fill in the task form
    await page.fill(`input[placeholder="${TASK_TITLE_PLACEHOLDER}"]`, "E2E Test Task");
    await page.fill(`textarea[placeholder="${TASK_DESCRIPTION_PLACEHOLDER}"]`, "This is a test task created by E2E");

    // Submit the form
    await page.click('button:has-text("Create Task")');

    // Verify the task appears on the board
    await expect(page.locator("text=E2E Test Task")).toBeVisible();

    // Verify it's in the Inbox column
    const inboxColumn = page.locator("div").filter({ hasText: /INBOX \(1\)/ }).first();
    await expect(inboxColumn).toBeVisible();
  });

  test("create a task via API and see it on the board", async ({ page, request }) => {
    // Create task via API
    const res = await apiCall(request, "post", "/tasks", {
      title: "API Created Task",
      description: "Created via API for E2E test",
      task_size: "medium",
    });
    expect(res.ok()).toBeTruthy();
    const task = await res.json();
    expect(task.id).toBeTruthy();
    expect(task.title).toBe("API Created Task");

    // Load the page and verify it shows up
    await page.goto("/");
    await page.waitForSelector("text=TOWN MAP");
    await expect(page.locator("text=API Created Task")).toBeVisible();
  });

  test("delete a task via API and verify removal", async ({ page, request }) => {
    // Create a task first
    const createRes = await apiCall(request, "post", "/tasks", {
      title: "Task To Delete",
      task_size: "small",
    });
    const task = await createRes.json();
    expect(task.id).toBeTruthy();

    // Delete via API
    const deleteRes = await apiCall(request, "delete", `/tasks/${task.id}`);
    expect(deleteRes.ok()).toBeTruthy();

    // Load page and verify the task does NOT appear
    await page.goto("/");
    await page.waitForSelector("text=TOWN MAP");
    await expect(page.locator("text=Task To Delete")).not.toBeVisible();
  });

  test("update task status via API", async ({ request }) => {
    // Create a task
    const createRes = await apiCall(request, "post", "/tasks", {
      title: "Status Update Test",
      task_size: "small",
    });
    const task = await createRes.json();
    expect(task.status).toBe("inbox");

    // Update to done
    const updateRes = await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "done",
    });
    const updated = await updateRes.json();
    expect(updated.status).toBe("done");
    expect(updated.completed_at).toBeTruthy();
  });
});
