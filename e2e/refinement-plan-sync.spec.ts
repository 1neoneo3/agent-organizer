import { test, expect } from "@playwright/test";
import { cleanupTestData, apiCall } from "./helpers.js";

test.describe("PUT /tasks/:id/refinement-plan", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test.afterEach(async ({ request }) => {
    await cleanupTestData(request);
  });

  test("syncs refinement plan for a task in refinement status", async ({ request }) => {
    const createRes = await apiCall(request, "post", "/tasks", {
      title: "Refinement Plan Sync Test",
      task_size: "small",
    });
    const task = await createRes.json();
    expect(task.id).toBeTruthy();

    // Move task to refinement status
    const updateRes = await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });
    const updated = await updateRes.json();
    expect(updated.status).toBe("refinement");

    // Sync refinement plan
    const planContent = "---REFINEMENT PLAN---\n## Goal\nTest plan\n---END REFINEMENT---";
    const syncRes = await apiCall(request, "put", `/tasks/${task.id}/refinement-plan`, {
      content: planContent,
      source: "file",
    });
    expect(syncRes.ok()).toBeTruthy();

    const synced = await syncRes.json();
    expect(synced.refinement_plan).toBe(planContent);
    expect(synced.refinement_completed_at).toBeTruthy();
  });

  test("returns 404 for non-existent task", async ({ request }) => {
    const res = await apiCall(request, "put", "/tasks/00000000-0000-0000-0000-000000000000/refinement-plan", {
      content: "Some plan",
    });
    expect(res.status()).toBe(404);
  });

  test("returns 409 when task is in_progress", async ({ request }) => {
    const createRes = await apiCall(request, "post", "/tasks", {
      title: "In Progress Plan Test",
      task_size: "small",
    });
    const task = await createRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "in_progress",
    });

    const res = await apiCall(request, "put", `/tasks/${task.id}/refinement-plan`, {
      content: "Plan for in-progress",
    });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("invalid_status");
  });

  test("returns 400 for empty content", async ({ request }) => {
    const createRes = await apiCall(request, "post", "/tasks", {
      title: "Empty Content Test",
      task_size: "small",
    });
    const task = await createRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });

    const res = await apiCall(request, "put", `/tasks/${task.id}/refinement-plan`, {
      content: "",
    });
    expect(res.status()).toBe(400);
  });

  test("logs plan-sync event in task logs", async ({ request }) => {
    const createRes = await apiCall(request, "post", "/tasks", {
      title: "Log Check Test",
      task_size: "small",
    });
    const task = await createRes.json();

    await apiCall(request, "put", `/tasks/${task.id}`, {
      status: "refinement",
    });

    await apiCall(request, "put", `/tasks/${task.id}/refinement-plan`, {
      content: "Plan with logging",
      source: "file",
    });

    // Check task logs
    const logsRes = await apiCall(request, "get", `/tasks/${task.id}/logs`);
    expect(logsRes.ok()).toBeTruthy();
    const logs = await logsRes.json();
    const syncLog = (logs as Array<{ message: string }>).find(
      (l) => l.message.includes("[plan-sync]"),
    );
    expect(syncLog).toBeTruthy();
    expect(syncLog!.message).toContain("updated from file");
  });
});
