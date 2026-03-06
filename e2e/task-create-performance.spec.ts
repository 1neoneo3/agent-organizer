import { test, expect } from "@playwright/test";
import { authenticate, cleanupTestData } from "./helpers.js";

test.describe("Task Create Performance", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("measures task creation round trip via UI", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("button", { name: "+ NEW QUEST" })).toBeVisible();

    const openStartedAt = Date.now();
    await page.getByRole("button", { name: "+ NEW QUEST" }).click();
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
    const modalOpenedAt = Date.now();

    const taskTitle = `Perf Task ${Date.now()}`;
    await page.getByPlaceholder("What needs to be done?").fill(taskTitle);
    await page.getByPlaceholder("Detailed instructions...").fill("Measure create-task latency");

    const submitStartedAt = Date.now();
    await page.getByRole("button", { name: "Create Task" }).click();
    await expect(page.getByText(taskTitle)).toBeVisible();
    const taskVisibleAt = Date.now();

    const openModalMs = modalOpenedAt - openStartedAt;
    const createTaskMs = taskVisibleAt - submitStartedAt;
    const totalMs = taskVisibleAt - openStartedAt;

    console.log(JSON.stringify({
      metric: "task_create_ui",
      open_modal_ms: openModalMs,
      create_task_ms: createTaskMs,
      total_ms: totalMs,
      task_title: taskTitle,
    }));
  });
});
