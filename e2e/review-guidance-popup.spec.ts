import { test, expect } from "@playwright/test";
import { authenticate, cleanupTestData, apiCall } from "./helpers.js";

test.describe("Review guidance popup", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("shows self review guidance on transition and opens the task detail", async ({ page, request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Self Review Quest",
      description: "Confirm the popup opens the selected task.",
      task_size: "small",
    });
    const task = await taskRes.json();

    await page.goto("/");
    await page.waitForSelector("text=TOWN MAP");

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "self_review",
    });

    const popup = page.getByTestId("review-guidance-popup");
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toContainText("SELF REVIEW");
    await expect(popup).toContainText("Check the implementation against the original request");

    await popup.getByTestId("review-guidance-open-task").click();

    await expect(popup).toBeHidden();
    await expect(page.getByRole("heading", { name: "Self Review Quest" })).toBeVisible();
    await expect(page.locator("text=Confirm the popup opens the selected task.")).toBeVisible();
  });

  test("switches copy for pr review, supports closing, and ignores same-status replays", async ({ page, request }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "PR Review Quest",
      task_size: "medium",
    });
    const task = await taskRes.json();

    await page.goto("/");
    await page.waitForSelector("text=TOWN MAP");

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "pr_review",
    });

    const popup = page.getByTestId("review-guidance-popup");
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await expect(popup).toContainText("PR REVIEW");
    await expect(popup).toContainText("Prepare reviewer context with diff, test evidence, and PR notes");

    await popup.getByTestId("review-guidance-close").click();
    await expect(popup).toBeHidden();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "pr_review",
    });

    await page.waitForTimeout(500);
    await expect(popup).toBeHidden();
  });
});
