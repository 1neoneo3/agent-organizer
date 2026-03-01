import { test, expect } from "@playwright/test";
import { authenticate, cleanupTestData, apiCall } from "./helpers.js";

test.describe("Agent CRUD", () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupTestData(request);
    await authenticate(page);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("create an agent via UI and verify it appears", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("text=Task Board");

    // Click "+ Agent" button
    await page.click("button:has-text('+ Agent')");

    // Fill in the agent form
    await page.fill('input[placeholder="e.g. coder-01"]', "e2e-test-agent");
    // Provider defaults to "claude", which is fine

    // Submit
    await page.click('button:has-text("Create")');

    // Verify the agent appears in the agent status bar
    await expect(page.locator("text=e2e-test-agent")).toBeVisible();
  });

  test("create an agent via API and verify on agents page", async ({ page, request }) => {
    // Create agent via API
    const res = await apiCall(request, "post", "/agents", {
      name: "api-test-agent",
      cli_provider: "claude",
      avatar_emoji: "🧪",
      agent_type: "worker",
    });
    expect(res.ok()).toBeTruthy();
    const agent = await res.json();
    expect(agent.id).toBeTruthy();
    expect(agent.name).toBe("api-test-agent");
    expect(agent.status).toBe("idle");

    // Navigate to agents page and verify
    await page.goto("/agents");
    await page.waitForSelector("text=api-test-agent");
    await expect(page.locator("text=api-test-agent")).toBeVisible();
  });

  test("delete an agent via API", async ({ request }) => {
    // Create agent
    const createRes = await apiCall(request, "post", "/agents", {
      name: "agent-to-delete",
      cli_provider: "codex",
    });
    const agent = await createRes.json();

    // Delete agent
    const deleteRes = await apiCall(request, "delete", `/agents/${agent.id}`);
    expect(deleteRes.ok()).toBeTruthy();
    const result = await deleteRes.json();
    expect(result.deleted).toBe(true);

    // Verify it's gone
    const getRes = await apiCall(request, "get", `/agents/${agent.id}`);
    expect(getRes.status()).toBe(404);
  });

  test("update an agent via API", async ({ request }) => {
    // Create agent
    const createRes = await apiCall(request, "post", "/agents", {
      name: "agent-to-update",
      cli_provider: "claude",
    });
    const agent = await createRes.json();

    // Update agent
    const updateRes = await apiCall(request, "put", `/agents/${agent.id}`, {
      name: "updated-agent-name",
      personality: "Helpful and thorough",
    });
    const updated = await updateRes.json();
    expect(updated.name).toBe("updated-agent-name");
    expect(updated.personality).toBe("Helpful and thorough");
  });
});
