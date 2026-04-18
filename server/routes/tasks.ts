import { Router } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { RuntimeContext, Agent, Task } from "../types/runtime.js";
import { spawnAgent, killAgent, queueFeedbackAndRestart, getCapturedSessionId, getPendingInteractivePrompt, getAllPendingInteractivePrompts, clearPendingInteractivePrompt } from "../spawner/process-manager.js";
import { triggerAutoReview } from "../spawner/auto-reviewer.js";
import { triggerAutoQa } from "../spawner/auto-qa.js";
import { triggerAutoCiCheck } from "../spawner/auto-ci-check.js";
import { triggerAutoTestGen } from "../spawner/auto-test-gen.js";
import { resolveActiveStages, nextStage, recordFailedStage, validateStatusTransition } from "../workflow/stage-pipeline.js";
import { loadProjectWorkflow } from "../workflow/loader.js";
import { prettyStreamJson } from "../spawner/pretty-stream-json.js";
import { readLastLines } from "../utils/read-last-lines.js";
import { AUTO_ASSIGN_TASK_ON_CREATE, AUTO_RUN_TASK_ON_CREATE, isOutputLanguage, type OutputLanguage } from "../config/runtime.js";
import { autoDispatchTask } from "../tasks/auto-dispatch.js";
import { TASK_STATUSES } from "../domain/task-status.js";
import { shouldStampCompletedAt } from "../domain/task-rules.js";
import { buildRefinementSplitArtifacts } from "../domain/output-language.js";
import {
  formatBlockingDependencies,
  getBlockingDependencies,
} from "../domain/task-dependencies.js";
import { detectRepositoryUrl, normalizeGitUrl } from "../workflow/git-utils.js";
import {
  isTaskOverridableKey,
  mergeOverrides,
  safeParseOverrides,
  TASK_OVERRIDABLE_KEYS,
} from "../domain/task-settings.js";

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullish(),
  assigned_agent_id: z.string().nullish(),
  project_path: z.string().nullish(),
  priority: z.number().int().min(0).max(10).default(0),
  task_size: z.enum(["small", "medium", "large"]).default("small"),
  repository_url: z.string().url().nullish(),
  repository_urls: z.array(z.string().url()).nullish(),
});

const UpdateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  assigned_agent_id: z.string().nullish(),
  project_path: z.string().nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.number().int().min(0).max(10).optional(),
  task_size: z.enum(["small", "medium", "large"]).optional(),
  result: z.string().nullish(),
  pr_url: z.string().url().nullish(),
  pr_urls: z.array(z.string().url()).nullish(),
  repository_url: z.string().url().nullish(),
  repository_urls: z.array(z.string().url()).nullish(),
});

/**
 * Resolve the repository_url for a task at write time. Precedence:
 *   1. An explicit URL the caller sent (normalized to canonical form)
 *   2. Auto-detected origin remote from the project_path (if it is a
 *      git working copy)
 *   3. null
 */
function resolveRepositoryUrl(
  explicit: string | null | undefined,
  projectPath: string | null | undefined,
): string | null {
  if (explicit) {
    return normalizeGitUrl(explicit) ?? explicit;
  }
  if (projectPath) {
    return detectRepositoryUrl(projectPath);
  }
  return null;
}

function resolveTaskOutputLanguage(
  db: RuntimeContext["db"],
  taskId: string,
): OutputLanguage {
  const taskRow = db
    .prepare("SELECT settings_overrides FROM tasks WHERE id = ?")
    .get(taskId) as { settings_overrides: string | null } | undefined;

  const overrideValue = taskRow
    ? safeParseOverrides(taskRow.settings_overrides)?.output_language
    : undefined;
  if (typeof overrideValue === "string" && isOutputLanguage(overrideValue)) {
    return overrideValue;
  }

  const globalRow = db
    .prepare("SELECT value FROM settings WHERE key = 'output_language'")
    .get() as { value: string } | undefined;
  if (globalRow?.value && isOutputLanguage(globalRow.value)) {
    return globalRow.value;
  }

  return "ja";
}

type InteractivePromptType = "exit_plan_mode" | "ask_user_question" | "text_input_request";

interface InteractiveResponseInput {
  promptType: InteractivePromptType;
  approved?: boolean;
  selectedOptions?: Record<string, string | string[]>;
  freeText?: string;
}

export function getInteractivePromptTypeMismatch(
  requestedPromptType: InteractivePromptType,
  pendingPromptType: InteractivePromptType,
): InteractivePromptType | null {
  return requestedPromptType === pendingPromptType ? null : pendingPromptType;
}

export function buildContinuePromptFromInteractiveResponse({
  promptType,
  approved,
  selectedOptions,
  freeText,
}: InteractiveResponseInput): string {
  if (promptType === "exit_plan_mode") {
    if (approved) {
      return "The user has approved your plan. Proceed with the implementation.";
    }
    return `The user has rejected your plan.${freeText ? ` Feedback: ${freeText}` : " Please revise your approach."}`;
  }

  if (promptType === "text_input_request") {
    return freeText
      ? `The user has responded to your request:\n\n${freeText}`
      : "The user acknowledged your request without a specific answer. Please proceed with your best judgment.";
  }

  const parts: string[] = [];
  if (selectedOptions && Object.keys(selectedOptions).length > 0) {
    for (const [question, answer] of Object.entries(selectedOptions)) {
      const answerStr = Array.isArray(answer) ? answer.join(", ") : answer;
      parts.push(`Q: ${question}\nA: ${answerStr}`);
    }
  }
  if (freeText) {
    parts.push(freeText);
  }
  return parts.length > 0
    ? `The user has responded to your questions:\n\n${parts.join("\n\n")}`
    : "The user acknowledged your question without a specific answer.";
}

export function resolveRequestedAgentId(
  taskAssignedAgentId: string | null | undefined,
  requestedAgentId: string | null | undefined,
): string | undefined {
  return requestedAgentId ?? taskAssignedAgentId ?? undefined;
}

function nextTaskNumber(db: RuntimeContext["db"]): string {
  const row = db.prepare(
    "SELECT MAX(CAST(SUBSTR(task_number, 2) AS INTEGER)) AS max_num FROM tasks WHERE task_number LIKE '#%'"
  ).get() as { max_num: number | null } | undefined;
  return `#${(row?.max_num ?? 0) + 1}`;
}

export function createTasksRouter(ctx: RuntimeContext): Router {
  const router = Router();
  const { db, ws, cache } = ctx;

  async function invalidateTaskCaches(): Promise<void> {
    await cache.invalidatePattern("tasks:*");
  }

  router.get("/tasks", async (req, res) => {
    const status = req.query.status as string | undefined;
    const cacheKey = status ? `tasks:status:${status}` : "tasks:all";

    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const tasks = status
      ? db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC").all(status)
      : db.prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at DESC").all();

    await cache.set(cacheKey, tasks, 10);
    res.json(tasks);
  });

  // GET /tasks/interactive-prompts — return all pending interactive prompts
  // Must be before /tasks/:id to avoid being caught by the param route
  router.get("/tasks/interactive-prompts", (_req, res) => {
    const all = getAllPendingInteractivePrompts();
    const result: Array<{ task_id: string } & Record<string, unknown>> = [];
    for (const [taskId, entry] of all) {
      result.push({ task_id: taskId, ...entry.data });
    }
    res.json(result);
  });

  router.get("/tasks/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!task) return res.status(404).json({ error: "not_found" });
    res.json(task);
  });

  router.post("/tasks", async (req, res) => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { title, description, assigned_agent_id, project_path, priority, task_size, repository_url, repository_urls } = parsed.data;

    // Prevent duplicate tasks: reject if a task with similar title is active (inbox/in_progress/qa_testing/pr_review)
    const duplicate = db.prepare(
      "SELECT id, task_number, status FROM tasks WHERE title = ? AND status IN ('inbox', 'refinement', 'in_progress', 'self_review', 'test_generation', 'qa_testing', 'pr_review', 'human_review', 'ci_check') LIMIT 1"
    ).get(title) as { id: string; task_number: string; status: string } | undefined;
    if (duplicate) {
      return res.status(409).json({
        error: "duplicate_task",
        message: `Active task with same title already exists: ${duplicate.task_number} (${duplicate.status})`,
        existing_task_id: duplicate.id,
      });
    }

    // Validate assigned_agent_id exists if provided
    if (assigned_agent_id) {
      const agent = db.prepare("SELECT id FROM agents WHERE id = ?").get(assigned_agent_id);
      if (!agent) {
        return res.status(400).json({ error: "invalid_agent", message: "Agent not found: " + assigned_agent_id });
      }
    }

    // Validate project_path is an existing directory if provided
    if (project_path) {
      const resolved = resolve(project_path);
      try {
        const stat = statSync(resolved);
        if (!stat.isDirectory()) {
          return res.status(400).json({ error: "invalid_project_path", message: "project_path must be a directory" });
        }
      } catch {
        // Path doesn't exist — allow it (may be created later)
      }
    }

    const id = randomUUID();
    const now = Date.now();
    const taskNumber = nextTaskNumber(db);
    // Multi-repo support: if repository_urls array is provided, use it;
    // otherwise fall back to single repository_url (legacy) or auto-detect.
    const urlArray: string[] = Array.isArray(repository_urls) && repository_urls.length > 0
      ? repository_urls.map((u) => normalizeGitUrl(u) ?? u)
      : (() => {
          const single = resolveRepositoryUrl(repository_url ?? null, project_path ?? null);
          return single ? [single] : [];
        })();
    const urlsJson = urlArray.length > 0 ? JSON.stringify(urlArray) : null;
    const primaryRepoUrl = urlArray[0] ?? null;

    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, project_path, priority, task_size, task_number, repository_url, repository_urls, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, title, description ?? null, assigned_agent_id ?? null, project_path ?? null, priority, task_size, taskNumber, primaryRepoUrl, urlsJson, now, now);

    let task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task;
    ws.broadcast("task_update", task);

    task = autoDispatchTask(db, ws, id, {
      autoAssign: AUTO_ASSIGN_TASK_ON_CREATE,
      autoRun: AUTO_RUN_TASK_ON_CREATE,
      cache,
      spawnAgent,
    }) as Task;
    await invalidateTaskCaches();
    await cache.del("agents:all");
    res.status(201).json(task);
  });

  router.put("/tasks/:id", async (req, res) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const parsed = UpdateTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const updates = parsed.data;
    const existingTask = existing as unknown as Task;

    // Validate pipeline order for status changes
    if (updates.status) {
      const workflow = loadProjectWorkflow(existingTask.project_path);
      const validationError = validateStatusTransition(db, existingTask.status, updates.status, workflow, existingTask.task_size);
      if (validationError) {
        return res.status(400).json({ error: "invalid_status_transition", message: validationError });
      }
    }

    // Repository URL resolution:
    //   - If the caller explicitly set repository_url, normalize and honor it
    //   - If project_path is changing and repository_url is not provided,
    //     re-detect from the new path so the link stays accurate
    if (updates.repository_url !== undefined && updates.repository_url !== null) {
      updates.repository_url = normalizeGitUrl(updates.repository_url) ?? updates.repository_url;
    } else if (
      updates.project_path !== undefined &&
      updates.project_path !== existingTask.project_path &&
      updates.repository_url === undefined
    ) {
      updates.repository_url = updates.project_path ? detectRepositoryUrl(updates.project_path) : null;
    }

    const now = Date.now();
    const fields: string[] = [];
    const values: unknown[] = [];

    // Convert repository_urls / pr_urls arrays to JSON, and sync the
    // legacy single-URL fields with the first element.
    if (Array.isArray(updates.repository_urls)) {
      const arr = updates.repository_urls.map((u) => normalizeGitUrl(u) ?? u);
      fields.push("repository_urls = ?");
      values.push(arr.length > 0 ? JSON.stringify(arr) : null);
      if (updates.repository_url === undefined && arr.length > 0) {
        fields.push("repository_url = ?");
        values.push(arr[0]);
      }
      delete (updates as Record<string, unknown>).repository_urls;
    }
    if (Array.isArray(updates.pr_urls)) {
      const arr = updates.pr_urls;
      fields.push("pr_urls = ?");
      values.push(arr.length > 0 ? JSON.stringify(arr) : null);
      if (updates.pr_url === undefined && arr.length > 0) {
        fields.push("pr_url = ?");
        values.push(arr[0]);
      }
      delete (updates as Record<string, unknown>).pr_urls;
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push((value ?? null) as string | number | null);
      }
    }

    if (updates.status && shouldStampCompletedAt(updates.status)) {
      fields.push("completed_at = ?");
      values.push(now);
    }

    fields.push("updated_at = ?");
    values.push(now);
    values.push(req.params.id);

    db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...(values as Array<string | number | null>));
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as unknown as Task;
    await invalidateTaskCaches();
    ws.broadcast("task_update", task);

    // Trigger auto-QA on manual status change to qa_testing
    if (updates.status === "qa_testing") {
      setTimeout(() => triggerAutoQa(db, ws, task, cache), 500);
    }

    // Trigger auto-review on manual status change to pr_review
    if (updates.status === "pr_review") {
      setTimeout(() => triggerAutoReview(db, ws, task, cache), 500);
    }

    res.json(task);
  });

  router.delete("/tasks/:id", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    // Kill any active agent process regardless of task.status. Previously
    // we only killed on in_progress, but refinement / pr_review /
    // qa_testing / ci_check / test_generation all run child processes
    // too. Leaving them alive after DELETE caused FOREIGN KEY violations
    // when the child's next stdout chunk tried to insert a task_log
    // referencing the now-deleted task id, crashing the server.
    killAgent(task.id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    await invalidateTaskCaches();
    res.json({ deleted: true });
  });

  // GET /tasks/:id/settings — return overrides + the allow-list of keys
  router.get("/tasks/:id/settings", (req, res) => {
    const task = db
      .prepare("SELECT settings_overrides FROM tasks WHERE id = ?")
      .get(req.params.id) as { settings_overrides: string | null } | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const overrides = safeParseOverrides(task.settings_overrides) ?? {};
    res.json({
      task_id: req.params.id,
      overrides,
      allowed_keys: TASK_OVERRIDABLE_KEYS,
    });
  });

  // PUT /tasks/:id/settings — merge a patch of {key: value|null} into
  // tasks.settings_overrides. `null` removes a key. Unknown keys are
  // rejected so typos cannot silently create dead config.
  router.put("/tasks/:id/settings", async (req, res) => {
    const PatchSchema = z.record(
      z.string(),
      z.union([z.string(), z.null()]),
    );
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const unknownKeys = Object.keys(parsed.data).filter((k) => !isTaskOverridableKey(k));
    if (unknownKeys.length > 0) {
      return res
        .status(400)
        .json({ error: "unknown_settings_keys", keys: unknownKeys, allowed_keys: TASK_OVERRIDABLE_KEYS });
    }

    const task = db
      .prepare("SELECT settings_overrides FROM tasks WHERE id = ?")
      .get(req.params.id) as { settings_overrides: string | null } | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const merged = mergeOverrides(task.settings_overrides, parsed.data);
    const serialized = merged ? JSON.stringify(merged) : null;
    const now = Date.now();
    db.prepare("UPDATE tasks SET settings_overrides = ?, updated_at = ? WHERE id = ?").run(
      serialized,
      now,
      req.params.id,
    );

    await invalidateTaskCaches();
    res.json({ task_id: req.params.id, overrides: merged ?? {} });
  });

  // DELETE /tasks/:id/settings — clear all overrides for a task
  router.delete("/tasks/:id/settings", async (req, res) => {
    const task = db.prepare("SELECT id FROM tasks WHERE id = ?").get(req.params.id) as { id: string } | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const now = Date.now();
    db.prepare("UPDATE tasks SET settings_overrides = NULL, updated_at = ? WHERE id = ?").run(now, req.params.id);
    await invalidateTaskCaches();
    res.json({ task_id: req.params.id, overrides: {} });
  });

  // Run a task (spawn agent)
  router.post("/tasks/:id/run", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status === "in_progress") return res.status(409).json({ error: "already_running" });

    // Dependency gate: a task whose prerequisite is still active (in_progress,
    // refinement, pr_review, …) must not advance — it may be about to edit
    // files that the prerequisite is still mutating. The auto-dispatcher
    // already enforces this for the inbox path; apply the same rule here
    // so manual Run cannot bypass the guard.
    const blockedBy = getBlockingDependencies(db, task);
    if (blockedBy.length > 0) {
      return res.status(409).json({
        error: "blocked_by_dependencies",
        message: `Blocked by: ${formatBlockingDependencies(blockedBy)}`,
        blocked_by: blockedBy,
      });
    }

    const agentId = resolveRequestedAgentId(task.assigned_agent_id, (req.body as { agent_id?: string }).agent_id);
    if (!agentId) return res.status(400).json({ error: "no_agent_assigned" });

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent | undefined;
    if (!agent) return res.status(404).json({ error: "agent_not_found" });
    if (agent.status === "working") return res.status(409).json({ error: "agent_busy" });

    // Assign agent if not already
    if (!task.assigned_agent_id) {
      db.prepare("UPDATE tasks SET assigned_agent_id = ? WHERE id = ?").run(agentId, task.id);
    }

    // Manual Run is an explicit user intent — reset any prior orphan-recovery
    // auto-respawn history so the task gets a fresh budget from zero.
    db.prepare("UPDATE tasks SET auto_respawn_count = 0 WHERE id = ?").run(task.id);

    const result = spawnAgent(db, ws, agent, { ...task, assigned_agent_id: agentId, auto_respawn_count: 0 }, { cache });
    res.json({ started: true, pid: result.pid });
  });

  // Stop a running task
  router.post("/tasks/:id/stop", async (req, res) => {
    const killed = killAgent(req.params.id, "user_stop");
    if (!killed) return res.status(404).json({ error: "not_running" });

    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, req.params.id);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (task?.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(now, task.assigned_agent_id);
      ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
    }

    await invalidateTaskCaches();
    await cache.del("agents:all");
    ws.broadcast("task_update", { id: req.params.id, status: "cancelled" });
    res.json({ stopped: true });
  });

  // Resume a cancelled task: re-assign agent and spawn back to in_progress
  router.post("/tasks/:id/resume", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status !== "cancelled") return res.status(409).json({ error: "not_cancelled" });

    // Dependency gate — see POST /tasks/:id/run for rationale. Resume re-
    // enters in_progress, so it must observe the same prerequisite state.
    const blockedBy = getBlockingDependencies(db, task);
    if (blockedBy.length > 0) {
      return res.status(409).json({
        error: "blocked_by_dependencies",
        message: `Blocked by: ${formatBlockingDependencies(blockedBy)}`,
        blocked_by: blockedBy,
      });
    }

    const agentId = resolveRequestedAgentId(task.assigned_agent_id, (req.body as { agent_id?: string }).agent_id);
    if (!agentId) return res.status(400).json({ error: "no_agent_assigned" });

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent | undefined;
    if (!agent) return res.status(404).json({ error: "agent_not_found" });
    if (agent.status === "working") return res.status(409).json({ error: "agent_busy" });

    const now = Date.now();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', completed_at = NULL, assigned_agent_id = ?, updated_at = ? WHERE id = ?"
    ).run(agentId, now, task.id);

    const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    ws.broadcast("task_update", { id: task.id, status: "in_progress" });
    const result = spawnAgent(db, ws, agent, freshTask, { cache });

    await invalidateTaskCaches();
    res.json({ resumed: true, pid: result.pid });
  });

  // Approve a task in human_review or refinement — advance to next stage
  router.post("/tasks/:id/approve", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const approvableStatuses = ["human_review", "refinement"];
    if (!approvableStatuses.includes(task.status)) {
      return res.status(400).json({ error: "not_in_approvable_status", current_status: task.status });
    }

    const isRefinement = task.status === "refinement";
    const workflow = loadProjectWorkflow(task.project_path);
    const activeStages = resolveActiveStages(db, workflow, task.task_size);
    const next = nextStage(task.status as "human_review" | "refinement", activeStages);
    const now = Date.now();

    // Dependency gate on refinement → in_progress advancement. The
    // refinement stage itself is read-only so it was fine to run while a
    // prerequisite was in_progress, but once we advance to implementation
    // the file-editing conflict risk applies. Block the advancement and
    // park the task back in inbox so the auto-dispatcher can pick it up
    // the moment the prerequisite finishes — matches the behavior of
    // POST /run and auto-dispatch.
    if (isRefinement && next === "in_progress") {
      const blockedBy = getBlockingDependencies(db, task);
      if (blockedBy.length > 0) {
        db.prepare(
          "UPDATE tasks SET status = 'inbox', assigned_agent_id = NULL, started_at = NULL, updated_at = ? WHERE id = ?",
        ).run(now, task.id);
        if (task.assigned_agent_id) {
          db.prepare(
            "UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?",
          ).run(now, task.assigned_agent_id);
          ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
        }
        db.prepare(
          "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
        ).run(
          task.id,
          `Refinement plan approved but advancement blocked: waiting on ${formatBlockingDependencies(blockedBy)}. Returned to inbox for auto-dispatch to retry when prerequisites finish.`,
        );

        await invalidateTaskCaches();
        ws.broadcast("task_update", { id: task.id, status: "inbox", assigned_agent_id: null, started_at: null });

        return res.status(409).json({
          error: "blocked_by_dependencies",
          message: `Refinement approved but blocked by: ${formatBlockingDependencies(blockedBy)}`,
          blocked_by: blockedBy,
          returned_to: "inbox",
        });
      }
    }

    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(next, now, task.id);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `${isRefinement ? "Refinement plan" : "Human review"} approved. Advancing to ${next}.`);

    await invalidateTaskCaches();
    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    ws.broadcast("task_update", updatedTask);

    // Trigger next stage's auto-agent if applicable
    if (next === "ci_check") {
      setTimeout(() => triggerAutoCiCheck(db, ws, updatedTask, cache), 500);
    }
    // After refinement approval → auto-dispatch to in_progress if agent is idle
    if (isRefinement && next === "in_progress" && updatedTask.assigned_agent_id) {
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(updatedTask.assigned_agent_id) as Agent | undefined;
      if (agent && agent.status === "idle") {
        setTimeout(() => spawnAgent(db, ws, agent, updatedTask, { cache }), 500);
      }
    }

    res.json({ approved: true, next_status: next });
  });

  // Reject a task in human_review or refinement — send back to inbox
  router.post("/tasks/:id/reject", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const approvableStatuses = ["human_review", "refinement"];
    if (!approvableStatuses.includes(task.status)) {
      return res.status(400).json({ error: "not_in_approvable_status", current_status: task.status });
    }

    const isRefinement = task.status === "refinement";
    const reason = (req.body as { reason?: string }).reason ?? (isRefinement ? "Refinement plan rejected" : "Rejected by human reviewer");
    const now = Date.now();

    db.prepare("UPDATE tasks SET status = 'inbox', assigned_agent_id = NULL, started_at = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
    // Release the assigned agent so it can pick up new work
    if (task.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(now, task.assigned_agent_id);
      ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
    }
    recordFailedStage(db, task.id, task.status as "human_review" | "refinement");
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `${isRefinement ? "Refinement plan" : "Human review"} rejected: ${reason}. Returning to inbox.`);

    await invalidateTaskCaches();
    ws.broadcast("task_update", { id: task.id, status: "inbox", assigned_agent_id: null, started_at: null });

    res.json({ rejected: true, reason });
  });

  // Split a refinement plan into individual tasks
  router.post("/tasks/:id/split", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (!task.refinement_plan) return res.status(400).json({ error: "no_refinement_plan" });

    // Parse implementation steps from the refinement plan
    const plan = task.refinement_plan;
    // Match both Japanese and English refinement-plan section headings.
    // Legacy plans used `## 実装計画 (Implementation Plan)`; current plans
    // emit either `## 実装計画` (ja) or `## Implementation Plan` (en).
    const implMatch = plan.match(/## (?:実装計画(?: \(Implementation Plan\))?|Implementation Plan)\s*\n([\s\S]*?)(?=\n## |\n---END REFINEMENT---)/);
    if (!implMatch) return res.status(400).json({ error: "no_implementation_steps" });

    const stepsRaw = implMatch[1].trim();
    const steps: Array<{ num: number; text: string }> = [];
    for (const match of stepsRaw.matchAll(/^(\d+)\.\s+(.+)$/gm)) {
      steps.push({ num: parseInt(match[1], 10), text: match[2].trim() });
    }
    if (steps.length === 0) return res.status(400).json({ error: "no_implementation_steps" });

    // Save plan to Docs/plans/
    let planPath: string | null = null;
    if (task.project_path) {
      const plansDir = join(task.project_path, "Docs", "plans");
      mkdirSync(plansDir, { recursive: true });
      const slug = task.title.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase();
      const filename = `${(task.task_number ?? "").replace("#", "")}-${slug}.md`;
      planPath = join(plansDir, filename);
      const content = `# ${task.title}\n\n${plan.replace(/^---REFINEMENT PLAN---\n?/, "").replace(/\n?---END REFINEMENT---$/, "")}`;
      writeFileSync(planPath, content, "utf-8");
    }

    // Build child refinement_plan referencing the parent plan
    const parentPlanClean = plan.replace(/^---REFINEMENT PLAN---\n?/, "").replace(/\n?---END REFINEMENT---$/, "");

    // Create child tasks with depends_on
    const now = Date.now();
    const childTasks: Task[] = [];
    const taskNumberMap = new Map<number, string>(); // step num -> task_number
    const outputLanguage = resolveTaskOutputLanguage(db, task.id);

    for (const step of steps) {
      const childId = randomUUID();
      const childNumber = nextTaskNumber(db);
      taskNumberMap.set(step.num, childNumber);

      // Build depends_on from previous step
      const deps: string[] = [];
      if (step.num > 1) {
        const prevNumber = taskNumberMap.get(step.num - 1);
        if (prevNumber) deps.push(prevNumber);
      }
      const depsJson = deps.length > 0 ? JSON.stringify(deps) : null;
      const hasDeps = deps.length > 0;
      const splitArtifacts = buildRefinementSplitArtifacts({
        language: outputLanguage,
        parentTaskNumber: task.task_number,
        stepNumber: step.num,
        totalSteps: steps.length,
        stepText: step.text,
        childNumbers: childNumber,
        planPath,
      });
      const description = splitArtifacts.description;
      // Inherit parent's refinement plan so child tasks skip refinement stage
      const childPlan = `${splitArtifacts.childPlan}\n\n${parentPlanClean}`;
      const repoUrl = task.repository_url ?? (task.project_path ? detectRepositoryUrl(task.project_path) : null);

      // Stamp `refinement_completed_at = now` so the child task's
      // `hasExistingPlan` check in spawnAgent treats the inherited plan
      // as a completed refinement and skips the stage, matching the
      // pre-#99-PR3 behavior where `refinement_plan != NULL` alone was
      // enough. Without this stamp, the stricter `hasExistingPlan`
      // rule (plan AND completed_at) would re-run refinement on every
      // child task.
      db.prepare(
        `INSERT INTO tasks (id, title, description, project_path, priority, task_size, task_number, depends_on, refinement_plan, refinement_completed_at, repository_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(childId, step.text, description, task.project_path, task.priority, task.task_size, childNumber, depsJson, childPlan, now, repoUrl, now, now);

      const child = db.prepare("SELECT * FROM tasks WHERE id = ?").get(childId) as unknown as Task;
      childTasks.push(child);
    }

    // Mark parent task as done with result
    const childNumbers = childTasks.map(c => c.task_number).join(", ");
    const result = buildRefinementSplitArtifacts({
      language: outputLanguage,
      parentTaskNumber: task.task_number,
      stepNumber: 1,
      totalSteps: steps.length,
      stepText: steps[0]?.text ?? task.title,
      childNumbers,
      planPath,
    }).result;
    db.prepare("UPDATE tasks SET status = 'done', result = ?, completed_at = ?, updated_at = ? WHERE id = ?").run(result, now, now, task.id);

    // Release agent if assigned
    if (task.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(now, task.assigned_agent_id);
      ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
    }

    await invalidateTaskCaches();
    const updatedParent = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    ws.broadcast("task_update", updatedParent);
    for (const child of childTasks) {
      ws.broadcast("task_update", child);
    }

    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `Task split into ${childNumbers}. Plan saved to ${planPath ?? "(no project path)"}.`);

    // Auto-dispatch the first child (no dependencies) immediately to in_progress
    const firstChild = childTasks[0];
    if (firstChild && !firstChild.depends_on) {
      setTimeout(() => autoDispatchTask(db, ws, firstChild.id, { autoAssign: true, autoRun: true, cache }), 500);
    }

    res.json({ parent: updatedParent, children: childTasks, plan_path: planPath });
  });

  // Get task logs
  router.get("/tasks/:id/logs", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const offset = Number(req.query.offset ?? 0);
    const logs = db.prepare(
      "SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ? OFFSET ?"
    ).all(req.params.id, limit, offset) as Array<Record<string, unknown> & { id: number; message: string }>;

    // Stage transition markers are inserted by the tasks_log_stage_transition
    // trigger on every status change. When a task is long-lived enough that
    // in-stage logs exceed `limit`, the oldest transition markers fall
    // outside the paginated window and the Activity terminal loses the
    // earliest stage segments (e.g. inbox→refinement, refinement→in_progress).
    // Always fold every transition marker for the task into the response so
    // the client can rebuild the full stage timeline regardless of pagination.
    const transitions = db.prepare(
      "SELECT * FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '__STAGE_TRANSITION__:%' ORDER BY id DESC"
    ).all(req.params.id) as Array<Record<string, unknown> & { id: number; message: string }>;

    const seen = new Set<number>(logs.map((row) => row.id));
    for (const row of transitions) {
      if (!seen.has(row.id)) {
        logs.push(row);
        seen.add(row.id);
      }
    }
    logs.sort((a, b) => Number(b.id) - Number(a.id));

    // Cap per-message length to keep the response payload bounded. Some rows
    // contain full tool-result JSON blobs (tens of KB each), which can push
    // the aggregated response to tens of megabytes and freeze the browser
    // when rendered in the Activity panel.
    const MAX_MESSAGE_LEN = 4000;
    const truncated = logs.map((row) => {
      if (typeof row.message === "string" && row.message.length > MAX_MESSAGE_LEN) {
        return {
          ...row,
          message: `${row.message.slice(0, MAX_MESSAGE_LEN)}... [truncated ${row.message.length - MAX_MESSAGE_LEN} bytes]`,
        };
      }
      return row;
    });
    res.json(truncated);
  });

  // Terminal view: pretty-printed log file + DB logs
  router.get("/tasks/:id/terminal", (req, res) => {
    const maxLines = Math.min(Number(req.query.lines ?? 2000), 10000);
    const pretty = req.query.pretty === "1";

    const logPath = join("data", "logs", `${req.params.id}.log`);
    let fileExists = false;

    if (existsSync(logPath)) {
      fileExists = true;
    }

    const rawText = fileExists ? readLastLines(logPath, maxLines) : "";
    let text = pretty ? prettyStreamJson(rawText) : rawText;

    // Cap response text to prevent browser freeze on large logs
    const MAX_TEXT_BYTES = 128 * 1024; // 128KB
    if (text.length > MAX_TEXT_BYTES) {
      text = text.slice(-MAX_TEXT_BYTES);
      const firstNewline = text.indexOf("\n");
      if (firstNewline > 0) {
        text = "[truncated]\n" + text.slice(firstNewline + 1);
      }
    }

    // Also fetch recent task_logs from DB for system/stderr entries
    const taskLogs = db.prepare(
      "SELECT kind, message, stage, agent_id, created_at FROM task_logs WHERE task_id = ? AND kind IN ('system', 'stderr') ORDER BY id DESC LIMIT 50"
    ).all(req.params.id) as Array<{ kind: string; message: string; stage: string | null; agent_id: string | null; created_at: number }>;

    // Fetch stage transitions (synthetic markers emitted by the tasks_log_stage_transition trigger)
    // so the terminal view can overlay stage boundaries on the raw log text.
    const stageTransitions = db.prepare(
      "SELECT stage, agent_id, message, created_at FROM task_logs " +
      "WHERE task_id = ? AND kind = 'system' AND message LIKE '__STAGE_TRANSITION__:%' " +
      "ORDER BY created_at ASC"
    ).all(req.params.id) as Array<{ stage: string; agent_id: string | null; message: string; created_at: number }>;

    res.json({
      ok: true,
      exists: fileExists,
      text,
      task_logs: taskLogs,
      stage_transitions: stageTransitions.map((row) => {
        // message format: "__STAGE_TRANSITION__:<from>→<to>"
        const match = row.message.match(/^__STAGE_TRANSITION__:(.+?)→(.+)$/);
        return {
          from: match ? match[1] : null,
          to: match ? match[2] : row.stage,
          stage: row.stage,
          agent_id: row.agent_id,
          created_at: row.created_at,
        };
      }),
    });
  });

  // CEO Feedback: send directive to a task (in_progress or finished)
  router.post("/tasks/:id/feedback", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const schema = z.object({ content: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { content } = parsed.data;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    // 1. Append to feedback file
    const feedbackDir = join("data", "feedback");
    mkdirSync(feedbackDir, { recursive: true });
    const feedbackPath = join(feedbackDir, `${task.id}.md`);
    appendFileSync(feedbackPath, `\n---\n## CEO Feedback (${timestamp})\n\n${content}\n`, "utf-8");

    // 2. Save as message
    const msgId = randomUUID();
    db.prepare(
      `INSERT INTO messages (id, sender_type, sender_id, content, message_type, task_id, created_at)
       VALUES (?, 'user', NULL, ?, 'directive', ?, ?)`
    ).run(msgId, content, task.id, now);

    // 3. Add system log — persist the full directive so the Activity tab
    // shows the whole instruction after a reload (previously we stored only
    // the first 200 chars, which hid user intent when revising refinement
    // plans). The /tasks/:id/logs endpoint caps per-message length at 4KB
    // on fetch, so bounded payload is still enforced at read time.
    const logMessage = `[CEO Feedback] ${content}`;
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, logMessage);

    // 4. Broadcast
    const message = db.prepare("SELECT * FROM messages WHERE id = ?").get(msgId);
    ws.broadcast("message_new", message);
    ws.broadcast("cli_output", { task_id: task.id, kind: "system", message: logMessage }, { taskId: task.id });

    // 5. Deliver feedback to agent
    const previousStatus = task.status;

    if (task.status === "in_progress" || (task.status === "refinement" && !task.completed_at)) {
      // Running refinement: log the inbox round-trip before killing
      if (task.status === "refinement") {
        db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(now, task.id);
        db.prepare(
          "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
        ).run(task.id, `[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.`);
        db.prepare("UPDATE tasks SET status = 'refinement', updated_at = ? WHERE id = ?").run(now, task.id);
      }
      // Running task: kill + respawn with --resume
      const restarted = queueFeedbackAndRestart(task.id, content, previousStatus);
      if (restarted) {
        return res.json({ sent: true, restarted, feedback_path: feedbackPath });
      }
      // Process already exited — fall through to idle-agent respawn below
    }

    // Agent process not running: respawn idle agent with --resume
    const agentId = task.assigned_agent_id;
    if (!agentId) return res.json({ sent: true, restarted: false, feedback_path: feedbackPath });

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent | undefined;
    if (!agent || agent.status === "working") {
      return res.json({ sent: true, restarted: false, feedback_path: feedbackPath });
    }

    // Refinement revise: transition through inbox so the stage_transition
    // trigger logs both refinement→inbox and inbox→refinement with timestamps
    if (previousStatus === "refinement") {
      db.prepare("UPDATE tasks SET status = 'inbox', completed_at = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
      ).run(task.id, `[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.`);
      db.prepare("UPDATE tasks SET status = 'refinement', updated_at = ? WHERE id = ?").run(now, task.id);
      ws.broadcast("task_update", { id: task.id, status: "refinement" });
    } else {
      // Manual feedback-rework is an explicit user intent — reset the
      // auto-respawn counter so a mid-rework crash gets a full retry budget.
      db.prepare("UPDATE tasks SET status = 'in_progress', completed_at = NULL, auto_respawn_count = 0, updated_at = ? WHERE id = ?").run(now, task.id);
      ws.broadcast("task_update", { id: task.id, status: "in_progress" });
    }

    const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    spawnAgent(db, ws, agent, freshTask, { continuePrompt: content, previousStatus, cache });

    res.json({ sent: true, restarted: true, feedback_path: feedbackPath });
  });

  // Interactive prompt response (ExitPlanMode / AskUserQuestion / text_input_request)
  const InteractiveResponseSchema = z.object({
    promptType: z.enum(["exit_plan_mode", "ask_user_question", "text_input_request"]),
    approved: z.boolean().optional(),
    selectedOptions: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    freeText: z.string().optional(),
  });

  router.post("/tasks/:id/interactive-response", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const pending = getPendingInteractivePrompt(task.id);
    if (!pending) return res.status(404).json({ error: "no_pending_prompt" });

    const parsed = InteractiveResponseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { promptType, approved, selectedOptions, freeText } = parsed.data;
    const promptTypeMismatch = getInteractivePromptTypeMismatch(promptType, pending.data.promptType);
    if (promptTypeMismatch) {
      return res.status(409).json({
        error: "prompt_type_mismatch",
        expected_prompt_type: promptTypeMismatch,
      });
    }

    // Build natural language response for the agent
    const continuePrompt = buildContinuePromptFromInteractiveResponse({
      promptType,
      approved,
      selectedOptions,
      freeText,
    });

    // Clear the pending prompt
    clearPendingInteractivePrompt(task.id, db);

    const now = Date.now();

    // Log the response
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `Interactive response: ${promptType} ${promptType === "exit_plan_mode" ? (approved ? "approved" : "rejected") : "answered"}`);

    // Broadcast resolved event
    ws.broadcast("interactive_prompt_resolved", { task_id: task.id });
    ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: `User responded to ${promptType}. Restarting agent...` }], { taskId: task.id });

    // Find agent and respawn with --resume
    const agentId = task.assigned_agent_id;
    if (!agentId) return res.json({ sent: true, restarted: false });

    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent | undefined;
    if (!agent || agent.status === "working") {
      return res.json({ sent: true, restarted: false });
    }

    // Ensure task is in_progress
    db.prepare("UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?").run(now, task.id);
    ws.broadcast("task_update", { id: task.id, status: "in_progress" });

    const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    spawnAgent(db, ws, agent, freshTask, { continuePrompt, previousStatus: "in_progress", cache, finalizeOnComplete: true });

    res.json({ sent: true, restarted: true });
  });

  return router;
}
