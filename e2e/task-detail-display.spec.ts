import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { authenticate, cleanupTestData, apiCall } from "./helpers.js";

/**
 * The webServer in playwright.config.ts launches the server with
 * `DB_PATH=data/e2e-test.db`. That path is relative to the server's CWD,
 * which is the project root. Playwright tests also run from the project
 * root, so the same relative path resolves to the same file.
 *
 * We open this DB read/write from the test only to inject `refinement_plan`
 * for fixture setup — the public PUT /tasks API intentionally does not
 * accept refinement_plan (it is owned by the workflow). Running the real
 * refinement pipeline would be non-deterministic, so direct SQL is the
 * safest setup path. SQLite is opened in WAL mode by the server (see
 * server/db/runtime.ts), which permits concurrent readers + one writer
 * across processes.
 */
const DB_FILE = resolve(process.cwd(), "data/e2e-test.db");

const DESCRIPTION_SUMMARY = [
  "DESCRIPTION_SENTINEL_ALPHA: Verify Description and Implementation Plan render as",
  "two independent sections in TaskDetailModal during the refinement stage.",
].join(" ");

const PLAN_SENTINEL = "PLAN_SENTINEL_OMEGA";

const REFINEMENT_PLAN_MARKDOWN = [
  "## 背景",
  "",
  `${PLAN_SENTINEL}: PR #172 introduced the Description vs Implementation Plan split.`,
  "This plan body must render below the Description heading without bleeding into it.",
  "",
  "## 受け入れ条件",
  "",
  "- [ ] Description セクションが概要のみを表示する",
  "- [ ] Implementation Plan セクションがこの markdown の全文を表示する",
  "- [ ] 同じ文字列が両セクションに二重表示されない",
  "",
  "## 実装計画",
  "",
  "1. TaskDetailModal を開く",
  "2. Description / Implementation Plan の両セクションが見えることを確認",
  "3. それぞれの内容が分離されていることを確認",
].join("\n");

function setRefinementPlan(taskId: string, plan: string): void {
  const db = new DatabaseSync(DB_FILE);
  try {
    const now = Date.now();
    db.prepare(
      "UPDATE tasks SET refinement_plan = ?, refinement_completed_at = ?, updated_at = ? WHERE id = ?",
    ).run(plan, now, now, taskId);
  } finally {
    db.close();
  }
}

test.describe("Task Detail Display — Description / Implementation Plan separation", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("Description and Implementation Plan render as independent sections during refinement", async ({
    page,
    request,
  }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Description vs Plan Display E2E",
      description: DESCRIPTION_SUMMARY,
      task_size: "medium",
    });
    expect(taskRes.ok()).toBeTruthy();
    const task = (await taskRes.json()) as { id: string };

    // Move into refinement stage. The task has no assigned agent, so this
    // does NOT trigger the refinement pipeline — it just flips the status.
    const statusRes = await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });
    expect(statusRes.ok()).toBeTruthy();

    // Inject refinement_plan via direct SQL. The PUT /tasks schema does not
    // expose refinement_plan, and we explicitly avoid running the real
    // refinement workflow (non-deterministic by design).
    setRefinementPlan(task.id, REFINEMENT_PLAN_MARKDOWN);

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
    await page.getByText("Description vs Plan Display E2E").click();

    const descriptionSection = page.getByTestId("task-description-section");
    const planSection = page.getByTestId("refinement-plan-section");

    await expect(descriptionSection).toBeVisible();
    await expect(planSection).toBeVisible();

    // Section headings live inside their respective containers — confirms
    // each section is rendered with its own labeled heading rather than a
    // shared one.
    await expect(
      descriptionSection.getByRole("heading", { name: "Description" }),
    ).toBeVisible();
    await expect(
      planSection.getByRole("heading", { name: "Implementation Plan" }),
    ).toBeVisible();

    // Each section contains only its own sentinel content. If either field
    // bled into the other (e.g. refinement_plan rendered inside Description
    // or vice versa), one of these four assertions will fail.
    await expect(descriptionSection).toContainText("DESCRIPTION_SENTINEL_ALPHA");
    await expect(descriptionSection).not.toContainText(PLAN_SENTINEL);

    await expect(planSection).toContainText(PLAN_SENTINEL);
    await expect(planSection).not.toContainText("DESCRIPTION_SENTINEL_ALPHA");

    // Plan markdown headings are rendered as <h2>/<h3> by react-markdown,
    // not as raw "## " text. Confirm structured rendering inside the plan.
    const planMarkdown = planSection.getByTestId("markdown-content");
    await expect(planMarkdown.locator("h2", { hasText: "背景" })).toBeVisible();
    await expect(planMarkdown.locator("h2", { hasText: "受け入れ条件" })).toBeVisible();
    await expect(planMarkdown.locator("h2", { hasText: "実装計画" })).toBeVisible();
  });

  test("both sections are visible simultaneously without tab switching", async ({
    page,
    request,
  }) => {
    const taskRes = await apiCall(request, "post", "/tasks", {
      title: "Simultaneous Sections E2E",
      description: DESCRIPTION_SUMMARY,
      task_size: "small",
    });
    const task = (await taskRes.json()) as { id: string };

    await apiCall(request, "put", `/tasks/${task.id}`, { status: "refinement" });
    setRefinementPlan(task.id, REFINEMENT_PLAN_MARKDOWN);

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Tasks" })).toBeVisible();
    await page.getByText("Simultaneous Sections E2E").click();

    // The Description tab is active by default. Both sections should be
    // mounted and visible at the same time on this tab — no tab switch is
    // required to see Implementation Plan.
    const descriptionSection = page.getByTestId("task-description-section");
    const planSection = page.getByTestId("refinement-plan-section");

    await expect(descriptionSection).toBeVisible();
    await expect(planSection).toBeVisible();

    // Sentinel content from both sources is on screen at once, proving the
    // sections coexist rather than being mutually exclusive views.
    await expect(page.getByText("DESCRIPTION_SENTINEL_ALPHA")).toBeVisible();
    await expect(page.getByText(new RegExp(PLAN_SENTINEL))).toBeVisible();
  });
});
