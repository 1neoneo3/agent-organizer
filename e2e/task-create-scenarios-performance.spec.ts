import { test, expect } from "@playwright/test";
import { authenticate, cleanupTestData, apiCall } from "./helpers.js";

async function measureSingleCreate(page: import("@playwright/test").Page, title: string) {
  const openStartedAt = Date.now();
  await page.getByRole("button", { name: "+ NEW QUEST" }).click();
  await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
  const modalOpenedAt = Date.now();

  await page.getByPlaceholder("What needs to be done?").fill(title);
  await page.getByPlaceholder("Detailed instructions...").fill("Scenario performance test");

  const submitStartedAt = Date.now();
  await page.getByRole("button", { name: "Create Task" }).click();
  await expect(page.getByText(title)).toBeVisible();
  const taskVisibleAt = Date.now();

  return {
    open_modal_ms: modalOpenedAt - openStartedAt,
    create_task_ms: taskVisibleAt - submitStartedAt,
    total_ms: taskVisibleAt - openStartedAt,
  };
}

test.describe("Task Create Performance Scenarios", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("measures 10 sequential task creations via UI", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "+ NEW QUEST" })).toBeVisible();

    const totals: number[] = [];
    const createOnly: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      const title = `Perf Batch ${Date.now()}-${index}`;
      const result = await measureSingleCreate(page, title);
      totals.push(result.total_ms);
      createOnly.push(result.create_task_ms);
    }

    const averageTotal = Math.round(totals.reduce((sum, value) => sum + value, 0) / totals.length);
    const averageCreate = Math.round(createOnly.reduce((sum, value) => sum + value, 0) / createOnly.length);

    console.log(JSON.stringify({
      metric: "task_create_ui_batch_10",
      average_total_ms: averageTotal,
      average_create_task_ms: averageCreate,
      slowest_total_ms: Math.max(...totals),
      fastest_total_ms: Math.min(...totals),
      samples: totals,
    }));
  });

  test("measures task creation with a populated board", async ({ page, request }) => {
    for (let index = 0; index < 100; index += 1) {
      await apiCall(request, "post", "/tasks", {
        title: `Seed Task ${index}`,
        task_size: "small",
      });
    }

    await page.goto("/");
    await expect(page.getByText("Seed Task 0")).toBeVisible();

    const title = `Perf With 100 Seeded ${Date.now()}`;
    const result = await measureSingleCreate(page, title);

    console.log(JSON.stringify({
      metric: "task_create_ui_with_100_seeded",
      ...result,
      task_title: title,
    }));
  });
});
