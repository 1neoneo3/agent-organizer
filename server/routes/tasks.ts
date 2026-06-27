import { Router, type Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { parseFeedbackRequest } from "./feedback-validation.js";
import { recordReadApi } from "../perf/metrics.js";
import type { RuntimeContext, Agent, Task } from "../types/runtime.js";
import { spawnAgent, killAgent, queueFeedbackAndRestart, getCapturedSessionId, getPendingInteractivePrompt, getAllPendingInteractivePrompts, clearPendingInteractivePrompt, isTaskProcessActive } from "../spawner/process-manager.js";
import { releaseAgentsForDeletedTask } from "../lifecycle/agent-pointer-reconcile.js";
import { formatSpawnFailureForUser, handleSpawnFailure, SpawnPreflightError } from "../spawner/spawn-failures.js";
import { isGuardedStage } from "../spawner/stage-agent-resolver.js";
import { triggerAutoReview } from "../spawner/auto-reviewer.js";
import { triggerAutoQa } from "../spawner/auto-qa.js";
import { triggerAutoTestGen } from "../spawner/auto-test-gen.js";
import { resolveActiveStages, nextStage, recordFailedStage, validateStatusTransition } from "../workflow/stage-pipeline.js";
import { loadProjectWorkflow } from "../workflow/loader.js";
import { resolveWorkspaceMode, tryCleanupCompletedTaskWorkspace } from "../workflow/workspace-manager.js";
import {
  assertRepositoryIdentity,
  parseExpectedRepositoryUrls,
  RepositoryIdentityError,
} from "../workflow/git-utils.js";
import { AUTO_ASSIGN_TASK_ON_CREATE, AUTO_RUN_TASK_ON_CREATE, isOutputLanguage, type OutputLanguage } from "../config/runtime.js";
import { autoDispatchTask } from "../tasks/auto-dispatch.js";
import {
  countAcceptanceCriteria,
  setAcceptanceCriterionChecked,
} from "../domain/acceptance-criteria.js";
import { TASK_STATUSES } from "../domain/task-status.js";
import { shouldStampCompletedAt } from "../domain/task-rules.js";
import { buildRefinementSplitArtifacts } from "../domain/output-language.js";
import {
  isRunnableImplementerAgent,
  resolveImplementerAgentForExecution as resolveImplementerAgentForExecutionCore,
  type ImplementerResolutionOptions,
  type ImplementerResolutionResult,
} from "../domain/implementer-agent.js";
import {
  deriveParentTaskNumber,
  deriveSplitIndex,
  deriveChildTaskNumbers,
} from "../domain/task-derived-fields.js";
import { buildTaskSummaryUpdate } from "../ws/update-payloads.js";
import { normalizePath } from "../domain/planned-files.js";
import {
  collectAllBlockers,
  formatAllBlockers,
  isBlocked,
} from "../domain/task-dependencies.js";
import { detectRepositoryUrl, normalizeGitUrl } from "../workflow/git-utils.js";
import { nextTaskNumber, isUuidLikeTitle } from "../domain/task-number.js";
import {
  getTaskSetting,
  isTaskOverridableKey,
  mergeOverrides,
  safeParseOverrides,
  TASK_OVERRIDABLE_KEYS,
  validateOverridesPatch,
} from "../domain/task-settings.js";
import {
  getLatestHumanReviewAutoStatus,
  getLatestHumanReviewAutoStatuses,
  recordHumanReviewAutoMarker,
} from "../domain/human-review-auto.js";
import { reconcileControllerDirective } from "../controller/orchestrator.js";
import {
  fetchControllerParentsByDirectiveIds,
  inferControllerParentForTask,
} from "../domain/controller-parent.js";

// Accept overrides as a flat string→string record on create/update so
// callers can seed stage toggles (default_enable_refinement, review_mode,
// …) atomically at creation. Without this, the first `resolveActiveStages`
// evaluation runs before any subsequent PATCH can land, and the initial
// auto-dispatch sees only the global settings. Values are string-typed to
// match the on-disk JSON (settings table stores "true"/"false" strings).
const SettingsOverridesPatch = z
  .record(z.string().min(1), z.union([z.string(), z.null()]))
  .optional();

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().nullish(),
  assigned_agent_id: z.string().nullish(),
  project_path: z.string().nullish(),
  priority: z.number().int().min(0).max(10).default(0),
  task_size: z.enum(["small", "medium", "large"]).default("small"),
  repository_url: z.string().url().nullish(),
  repository_urls: z.array(z.string().url()).nullish(),
  settings_overrides: SettingsOverridesPatch,
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
  settings_overrides: SettingsOverridesPatch,
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

function logRepositoryAutoDetectWarning(
  db: RuntimeContext["db"],
  taskId: string,
  projectPath: string | null | undefined,
  repositoryUrl: string | null,
): void {
  if (!projectPath || repositoryUrl) return;
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
  ).run(
    taskId,
    `[Repository Warning] repository_url could not be auto-detected for project_path=${projectPath}. ` +
      "git-worktree execution will require project_path to be the git toplevel with origin configured, or an explicit repository_url.",
  );
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

function isTaskControllerModeEnabled(db: RuntimeContext["db"], taskId: string): boolean {
  return getTaskSetting(db, "enable_controller_mode", taskId) === "true";
}

interface ImplementationStep {
  num: number;
  title: string;
  text: string;
}

interface PlanSplitResult {
  parent: Task;
  children: Task[];
  planPath: string | null;
  directiveId: string | null;
}

interface PlanSplitError {
  error: "no_refinement_plan" | "no_implementation_steps" | "missing_write_scope";
  message?: string;
  step?: number;
}

function cleanRefinementPlan(plan: string): string {
  return plan.replace(/^---REFINEMENT PLAN---\n?/, "").replace(/\n?---END REFINEMENT---$/, "");
}

function parseImplementationSteps(plan: string): ImplementationStep[] {
  // Match both Japanese and English refinement-plan section headings.
  // Legacy plans used `## 実装計画 (Implementation Plan)`; current plans
  // emit either `## 実装計画` (ja) or `## Implementation Plan` (en).
  const implMatch = plan.match(/## (?:実装計画(?: \(Implementation Plan\))?|Implementation Plan)\s*\n([\s\S]*?)(?=\n## |\n---END REFINEMENT---)/);

  const steps: ImplementationStep[] = [];
  const body = (implMatch?.[1] ?? cleanRefinementPlan(plan)).trim();
  const stepPattern = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:(\d+)\.\s+|Step\s+(\d+)\s*[:：]\s*)([^\n]*)([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?(?:\d+\.\s+|Step\s+\d+\s*[:：]\s*)|$)/gi;
  for (const match of body.matchAll(stepPattern)) {
    const num = match[1] ?? match[2];
    const titleLine = match[3].trim();
    const rest = match[4].trim();
    const text = [titleLine, rest].filter(Boolean).join("\n").trim();
    if (!text) continue;
    const title = titleLine || text.split(/\r?\n/, 1)[0]?.trim() || text;
    steps.push({ num: parseInt(num, 10), title, text });
  }

  return steps;
}

function savePlanToDocs(task: Task, plan: string): string | null {
  if (!task.project_path) return null;

  const plansDir = join(task.project_path, "Docs", "plans");
  mkdirSync(plansDir, { recursive: true });
  const slug = task.title.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).toLowerCase();
  const filename = `${(task.task_number ?? "").replace("#", "")}-${slug}.md`;
  const planPath = join(plansDir, filename);
  writeFileSync(planPath, `# ${task.title}\n\n${cleanRefinementPlan(plan)}`, "utf-8");
  return planPath;
}

function isWriteScopePath(path: string): boolean {
  if (path.includes("/")) return true;
  if (path.startsWith(".")) return true;
  if (/^(README|AGENTS|LICENSE|CHANGELOG|CONTRIBUTING)(?:\.[A-Za-z0-9]+)?$/.test(path)) return true;
  return /^[a-z0-9][a-z0-9_.-]*\.[a-z0-9][a-z0-9_.-]*$/.test(path);
}

function extractStepWriteScope(stepText: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const path = normalizePath(raw);
    if (!path || seen.has(path)) return;
    if (!isWriteScopePath(path)) return;
    seen.add(path);
    out.push(path);
  };

  for (const line of stepText.split(/\r?\n/)) {
    if (!/^\s*(?:[-*]\s*)?(?:Write scope|書き込み(?:対象|範囲))\s*(?:は|:|：)/i.test(line)) continue;
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      add(match[1]);
    }
  }
  return out;
}

function createControllerDirectiveForPlan(ctx: RuntimeContext, task: Task, plan: string, now: number): string {
  const directiveId = randomUUID();
  ctx.db.prepare(
    `INSERT INTO directives (
       id, title, content, issued_by_type, issued_by_id, status, project_path,
       controller_mode, controller_stage, created_at, updated_at
     ) VALUES (?, ?, ?, 'user', NULL, 'active', ?, 1, 'implement', ?, ?)`,
  ).run(
    directiveId,
    `Controller: ${task.task_number ? `${task.task_number} ` : ""}${task.title}`,
    cleanRefinementPlan(plan),
    task.project_path,
    now,
    now,
  );
  const directive = ctx.db.prepare("SELECT * FROM directives WHERE id = ?").get(directiveId);
  ctx.ws.broadcast("directive_update", directive);
  return directiveId;
}

function splitRefinementPlanIntoTasks(
  ctx: RuntimeContext,
  task: Task,
  options: { controllerMode: boolean },
): PlanSplitResult | PlanSplitError {
  if (!task.refinement_plan) return { error: "no_refinement_plan" };

  const steps = parseImplementationSteps(task.refinement_plan);
  if (steps.length === 0) {
    return {
      error: "no_implementation_steps",
      message:
        "Refinement plan must include implementation steps as `1. ...` or `Step 1:` entries, preferably under `## 実装計画` / `## Implementation Plan`.",
    };
  }

  if (options.controllerMode) {
    for (const step of steps) {
      const writeScope = extractStepWriteScope(step.text);
      if (writeScope.length === 0) {
        return {
          error: "missing_write_scope",
          step: step.num,
          message: `Controller split step ${step.num} is missing a backtick-quoted Write scope file path.`,
        };
      }
    }
  }

  const db = ctx.db;
  const now = Date.now();
  const planPath = savePlanToDocs(task, task.refinement_plan);
  const parentPlanClean = cleanRefinementPlan(task.refinement_plan);
  const outputLanguage = resolveTaskOutputLanguage(db, task.id);
  const repoUrl = task.repository_url ?? (task.project_path ? detectRepositoryUrl(task.project_path) : null);
  const directiveId = options.controllerMode ? createControllerDirectiveForPlan(ctx, task, task.refinement_plan, now) : null;
  const childTasks: Task[] = [];
  const taskNumberMap = new Map<number, string>();

  for (const step of steps) {
    const childId = randomUUID();
    const childNumber = nextTaskNumber(db);
    taskNumberMap.set(step.num, childNumber);

    const deps: string[] = [];
    if (!options.controllerMode && step.num > 1) {
      const prevNumber = taskNumberMap.get(step.num - 1);
      if (prevNumber) deps.push(prevNumber);
    }
    const depsJson = deps.length > 0 ? JSON.stringify(deps) : null;
    const splitArtifacts = buildRefinementSplitArtifacts({
      language: outputLanguage,
      parentTaskNumber: task.task_number,
      stepNumber: step.num,
      totalSteps: steps.length,
      stepText: step.text,
      childNumbers: childNumber,
      planPath,
    });
    const childPlan = `${splitArtifacts.childPlan}\n\n${parentPlanClean}`;
    const writeScope = options.controllerMode ? extractStepWriteScope(step.text) : [];
    const scopedPlannedFiles = writeScope.length > 0 ? JSON.stringify(writeScope) : task.planned_files;

    db.prepare(
      `INSERT INTO tasks (
         id, title, description, project_path, priority, task_size, task_number,
         parent_task_id, parent_task_number, split_index, split_total,
         depends_on, refinement_plan, refinement_completed_at, planned_files,
         repository_url, directive_id, controller_stage, write_scope,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      childId,
      step.title,
      splitArtifacts.description,
      task.project_path,
      task.priority,
      task.task_size,
      childNumber,
      task.id,
      task.task_number,
      step.num,
      steps.length,
      depsJson,
      childPlan,
      now,
      scopedPlannedFiles,
      repoUrl,
      directiveId,
      options.controllerMode ? "implement" : null,
      writeScope.length > 0 ? JSON.stringify(writeScope) : null,
      now,
      now,
    );

    const child = db.prepare("SELECT * FROM tasks WHERE id = ?").get(childId) as unknown as Task;
    childTasks.push(child);
  }

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

  db.prepare("UPDATE tasks SET status = 'done', result = ?, completed_at = ?, updated_at = ? WHERE id = ?")
    .run(result, now, now, task.id);

  try { tryCleanupCompletedTaskWorkspace(task); } catch { /* non-fatal */ }

  if (task.assigned_agent_id) {
    db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?")
      .run(now, task.assigned_agent_id);
    ctx.ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
  }

  const updatedParent = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
  ctx.ws.broadcast("task_update", buildTaskSummaryUpdate(updatedParent, { db }));
  for (const child of childTasks) {
    ctx.ws.broadcast("task_update", buildTaskSummaryUpdate(child, { db }));
  }

  const mode = options.controllerMode ? "Controller Mode task split" : "Task split";
  db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)")
    .run(task.id, `${mode} into ${childNumbers}. Plan saved to ${planPath ?? "(no project path)"}.`);

  return { parent: updatedParent, children: childTasks, planPath, directiveId };
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

export type { ImplementerResolutionOptions, ImplementerResolutionResult };

export function resolveImplementerAgentForExecution(
  db: RuntimeContext["db"],
  taskAssignedAgentId: string | null | undefined,
  requestedAgentId: string | null | undefined,
  options: ImplementerResolutionOptions = {},
): ImplementerResolutionResult {
  return resolveImplementerAgentForExecutionCore(db, taskAssignedAgentId, requestedAgentId, options);
}

type ResumeAgentResolutionResult =
  | { ok: true; agent: Agent; previousStatus: string }
  | { ok: false; error: "agent_not_found" | "agent_busy" | "no_runner_available" };

function isRunnableStageRunner(agent: Agent): boolean {
  return agent.status === "idle" && agent.agent_type === "worker" && agent.current_task_id === null;
}

function resolveAgentForResume(
  db: RuntimeContext["db"],
  task: Task,
  previousStatus: string,
  preferredRunnerAgentId?: string | null,
): ResumeAgentResolutionResult {
  if (!isGuardedStage(previousStatus)) {
    const resolution = resolveImplementerAgentForExecution(db, task.assigned_agent_id, undefined, {
      taskId: task.id,
    });
    return resolution.ok
      ? { ok: true, agent: resolution.agent, previousStatus }
      : { ok: false, error: resolution.error === "agent_busy" ? "agent_busy" : "no_runner_available" };
  }

  const runnerId = preferredRunnerAgentId ?? task.assigned_agent_id;
  if (!runnerId) {
    return { ok: false, error: "no_runner_available" };
  }

  const runner = db.prepare("SELECT * FROM agents WHERE id = ?").get(runnerId) as Agent | undefined;
  if (!runner) {
    return { ok: false, error: "agent_not_found" };
  }
  if (runner.status === "working") {
    return { ok: false, error: "agent_busy" };
  }
  if (!isRunnableStageRunner(runner)) {
    return { ok: false, error: "no_runner_available" };
  }
  return { ok: true, agent: runner, previousStatus };
}

function sendMeasuredJson(
  res: Response,
  route: string,
  startedAt: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  recordReadApi(route, performance.now() - startedAt, Buffer.byteLength(body));
  res.type("application/json").send(body);
}

function markRefinementRevisionRequested(
  db: RuntimeContext["db"],
  taskId: string,
  now: number,
): void {
  db.prepare(
    `UPDATE tasks
     SET refinement_revision_requested_at = ?,
         refinement_revision_completed_at = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(now, now, taskId);
}

function fetchTaskById(
  db: RuntimeContext["db"],
  taskId: string,
): Task | undefined {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
}

function createFeedbackResumePreflightError(
  db: RuntimeContext["db"],
  task: Task,
): SpawnPreflightError | null {
  if (!task.project_path) return null;

  const workflow = loadProjectWorkflow(task.project_path);
  if (resolveWorkspaceMode(workflow, db) !== "git-worktree") return null;

  try {
    assertRepositoryIdentity(
      task.id,
      task.project_path,
      parseExpectedRepositoryUrls(task.repository_urls, task.repository_url),
    );
    return null;
  } catch (error) {
    if (error instanceof RepositoryIdentityError) {
      return new SpawnPreflightError(error.code, error.message, false);
    }
    throw error;
  }
}

type TasksRouterDeps = {
  spawnAgent?: typeof spawnAgent;
  queueFeedbackAndRestart?: typeof queueFeedbackAndRestart;
  isTaskProcessActive?: typeof isTaskProcessActive;
};

const STAGE_TRANSITION_MESSAGE_PREFIX = "__STAGE_TRANSITION__:";

export function createTasksRouter(ctx: RuntimeContext, deps: TasksRouterDeps = {}): Router {
  const router = Router();
  const { db, ws } = ctx;
  const taskSpawner = deps.spawnAgent ?? spawnAgent;
  const feedbackRestarter = deps.queueFeedbackAndRestart ?? queueFeedbackAndRestart;
  const processActive = deps.isTaskProcessActive ?? isTaskProcessActive;

  const TASK_SUMMARY_COLS = [
    "id", "title", "assigned_agent_id", "project_path", "status",
    "priority", "task_size", "task_number", "parent_task_id",
    "parent_task_number", "split_index", "split_total", "depends_on",
    "planned_files",
    "controller_stage",
    "refinement_completed_at", "refinement_revision_requested_at",
    "refinement_revision_completed_at", "review_count", "directive_id",
    "pr_url", "external_source", "external_id", "review_branch",
    "review_commit_sha", "review_sync_status", "review_sync_error",
    "repository_url", "settings_overrides", "started_at", "completed_at",
    "last_heartbeat_at", "auto_respawn_count", "created_at", "updated_at",
  ].join(", ");

  // Derive parent/child kanban refs and has_plan flag from short head
  // slices of description/result + a non-null boolean over refinement_plan.
  // Avoids shipping the full description / result / refinement_plan
  // columns (potentially tens of KB each) to the list endpoint.
  const TASK_DERIVED_COLS = [
    "SUBSTR(description, 1, 80) AS _desc_head",
    "SUBSTR(result, 1, 200) AS _result_head",
    "CASE WHEN refinement_plan IS NOT NULL AND refinement_plan != '' THEN 1 ELSE 0 END AS has_refinement_plan",
  ].join(", ");

  function attachDerivedFields(rows: unknown[]): unknown[] {
    const controllerParentByDirectiveId = fetchControllerParentsByDirectiveIds(
      db,
      rows
        .filter((raw) => {
          const r = raw as {
            controller_stage?: string | null;
            directive_id?: string | null;
            parent_task_id?: string | null;
            parent_task_number?: string | null;
            _desc_head?: string | null;
          };
          const parentNumber = r.parent_task_number ?? deriveParentTaskNumber(r._desc_head ?? null);
          return r.controller_stage === "integrate" && typeof r.directive_id === "string" && !r.parent_task_id && !parentNumber;
        })
        .map((raw) => (raw as { directive_id: string }).directive_id),
    );
    const parentNumberByRow = rows.map((raw) => {
      const r = raw as { parent_task_number?: string | null; _desc_head?: string | null };
      const parentNumber = r.parent_task_number ?? deriveParentTaskNumber(r._desc_head ?? null);
      if (parentNumber) return parentNumber;
      const directiveId = (raw as { directive_id?: string | null }).directive_id;
      return directiveId ? controllerParentByDirectiveId.get(directiveId)?.task_number ?? null : null;
    });
    const parentIds = Array.from(new Set(
      rows
        .map((raw) => {
          const r = raw as { parent_task_id?: string | null; directive_id?: string | null };
          return r.parent_task_id ?? (r.directive_id ? controllerParentByDirectiveId.get(r.directive_id)?.id ?? null : null);
        })
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ));
    const parentNumbers = Array.from(new Set(
      parentNumberByRow.filter((num): num is string => typeof num === "string" && num.length > 0),
    ));
    const parentTitleById = new Map<string, string>();
    const parentIdByNumber = new Map<string, string>();
    const parentTitleByNumber = new Map<string, string>();
    if (parentIds.length > 0) {
      const placeholders = parentIds.map(() => "?").join(", ");
      const parentRows = db.prepare(`SELECT id, title FROM tasks WHERE id IN (${placeholders})`).all(...parentIds) as Array<{
        id: string;
        title: string;
      }>;
      for (const parent of parentRows) parentTitleById.set(parent.id, parent.title);
    }
    if (parentNumbers.length > 0) {
      const placeholders = parentNumbers.map(() => "?").join(", ");
      const parentRows = db.prepare(
        `SELECT id, task_number, title FROM tasks WHERE task_number IN (${placeholders}) ORDER BY CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END, created_at DESC`,
      ).all(...parentNumbers) as Array<{
        id: string;
        task_number: string;
        title: string;
      }>;
      for (const parent of parentRows) {
        if (parentIdByNumber.has(parent.task_number)) continue;
        parentIdByNumber.set(parent.task_number, parent.id);
        parentTitleByNumber.set(parent.task_number, parent.title);
      }
    }
    const humanReviewStatusByTaskId = getLatestHumanReviewAutoStatuses(
      db,
      rows
        .map((raw) => (raw as { id?: unknown }).id)
        .filter((id): id is string => typeof id === "string"),
    );

    return rows.map((raw, index) => {
      const r = raw as {
        parent_task_id?: string | null;
        parent_task_number?: string | null;
        split_index?: number | null;
        split_total?: number | null;
        _desc_head?: string | null;
        _result_head?: string | null;
        has_refinement_plan?: number | boolean;
      } & Record<string, unknown>;
      const out: Record<string, unknown> = { ...r };
      const directiveId = typeof r.directive_id === "string" ? r.directive_id : null;
      const controllerParent = directiveId ? controllerParentByDirectiveId.get(directiveId) ?? null : null;
      const parentNumber = parentNumberByRow[index] ?? null;
      const parentId = r.parent_task_id ?? controllerParent?.id ?? (parentNumber ? parentIdByNumber.get(parentNumber) ?? null : null);
      out.parent_task_id = parentId;
      out.parent_task_number = parentNumber;
      out.parent_task_title = parentId
        ? parentTitleById.get(parentId) ?? controllerParent?.title ?? (parentNumber ? parentTitleByNumber.get(parentNumber) ?? null : null)
        : parentNumber ? parentTitleByNumber.get(parentNumber) ?? null : null;
      out.split_index = r.split_index ?? deriveSplitIndex(r._desc_head ?? null);
      out.child_task_numbers = deriveChildTaskNumbers(r._result_head ?? null);
      out.has_refinement_plan = Boolean(r.has_refinement_plan);
      out.human_review_auto_status = typeof r.id === "string" ? humanReviewStatusByTaskId.get(r.id) ?? null : null;
      delete out._desc_head;
      delete out._result_head;
      return out;
    });
  }

  function firstQueryValue(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const first = value.find((entry): entry is string => typeof entry === "string");
      return first;
    }
    return undefined;
  }

  function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`);
  }

  const TASK_SEARCH_COLS = [
    "title",
    "task_number",
    "project_path",
    "description",
    "result",
    "refinement_plan",
    "planned_files",
    "pr_url",
    "repository_url",
    "repository_urls",
    "pr_urls",
    "merged_pr_urls",
    "external_source",
    "external_id",
    "review_branch",
    "review_commit_sha",
  ];

  router.get("/tasks", (req, res) => {
    const t0 = performance.now();
    const status = firstQueryValue(req.query.status);
    const rawSearch = firstQueryValue(req.query.search) ?? firstQueryValue(req.query.q);
    const search = rawSearch?.trim().slice(0, 200) ?? "";
    const whereParts: string[] = [];
    const params: string[] = [];

    if (status) {
      whereParts.push("status = ?");
      params.push(status);
    }

    if (search) {
      const likeParam = `%${escapeLikePattern(search)}%`;
      whereParts.push(`(${TASK_SEARCH_COLS.map((col) => `COALESCE(${col}, '') LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      params.push(...TASK_SEARCH_COLS.map(() => likeParam));
    }

    const whereSql = whereParts.length > 0 ? ` WHERE ${whereParts.join(" AND ")}` : "";
    const rows = db
      .prepare(`SELECT ${TASK_SUMMARY_COLS}, ${TASK_DERIVED_COLS} FROM tasks${whereSql} ORDER BY priority DESC, created_at DESC`)
      .all(...params);
    const tasks = attachDerivedFields(rows);
    sendMeasuredJson(res, "/tasks", t0, tasks);
  });

  // GET /tasks/interactive-prompts — return all pending interactive prompts
  // Must be before /tasks/:id to avoid being caught by the param route
  router.get("/tasks/interactive-prompts", (_req, res) => {
    const t0 = performance.now();
    const all = getAllPendingInteractivePrompts();
    const result: Array<{ task_id: string } & Record<string, unknown>> = [];
    for (const [taskId, entry] of all) {
      result.push({ task_id: taskId, ...entry.data });
    }
    sendMeasuredJson(res, "/tasks/interactive-prompts", t0, result);
  });

  router.get("/tasks/:id", (req, res) => {
    const t0 = performance.now();
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const parentNumber = typeof task.parent_task_number === "string"
      ? task.parent_task_number
      : deriveParentTaskNumber(typeof task.description === "string" ? task.description : null);
    const controllerStage = typeof task.controller_stage === "string"
      ? task.controller_stage as Task["controller_stage"]
      : null;
    const controllerParent = parentNumber ? null : inferControllerParentForTask(db, {
      controller_stage: controllerStage,
      directive_id: typeof task.directive_id === "string" ? task.directive_id : null,
      parent_task_id: typeof task.parent_task_id === "string" ? task.parent_task_id : null,
      parent_task_number: typeof task.parent_task_number === "string" ? task.parent_task_number : null,
    });
    const resolvedParentNumber = parentNumber ?? controllerParent?.task_number ?? null;
    const parent = typeof task.parent_task_id === "string"
      ? db.prepare("SELECT id, title FROM tasks WHERE id = ?").get(task.parent_task_id) as { id: string; title: string } | undefined
      : controllerParent
        ? controllerParent
        : resolvedParentNumber
        ? db.prepare("SELECT id, title FROM tasks WHERE task_number = ? ORDER BY CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END, created_at DESC LIMIT 1").get(resolvedParentNumber) as { id: string; title: string } | undefined
        : undefined;
    const splitIndex = typeof task.split_index === "number"
      ? task.split_index
      : deriveSplitIndex(typeof task.description === "string" ? task.description : null);
    const parentTitle = parent?.title ?? null;
    sendMeasuredJson(res, "/tasks/:id", t0, {
      ...task,
      parent_task_id: task.parent_task_id ?? parent?.id ?? null,
      parent_task_number: resolvedParentNumber,
      parent_task_title: parentTitle,
      split_index: splitIndex,
      human_review_auto_status: getLatestHumanReviewAutoStatus(db, task.id as string),
    });
  });

  router.post("/tasks", (req, res) => {
    const parsed = CreateTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { title, description, assigned_agent_id, project_path, priority, task_size, repository_url, repository_urls, settings_overrides: overridesPatch } = parsed.data;

    if (isUuidLikeTitle(title)) {
      return res.status(400).json({
        error: "invalid_title",
        message: "Title must not be a machine-generated UUID placeholder",
      });
    }

    // Reject unknown override keys up front so typos cannot silently
    // create dead config in tasks.settings_overrides.
    const validated = validateOverridesPatch(overridesPatch);
    if (!validated.ok) {
      return res.status(400).json({
        error: "invalid_settings_overrides",
        message: `Unknown override keys: ${validated.invalidKeys.join(", ")}`,
        allowed_keys: TASK_OVERRIDABLE_KEYS,
      });
    }

    // Prevent duplicate tasks: reject if a task with similar title is active (inbox/in_progress/qa_testing/pr_review)
    const duplicate = db.prepare(
      "SELECT id, task_number, status FROM tasks WHERE title = ? AND status IN ('inbox', 'refinement', 'in_progress', 'test_generation', 'qa_testing', 'pr_review', 'human_review') LIMIT 1"
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

    // Serialize overrides for initial insert so the very first
    // resolveActiveStages evaluation inside autoDispatchTask below already
    // sees the per-task toggles. Without this, the first dispatch tick
    // would use the global settings and spawn refinement even when the
    // caller explicitly disabled it.
    const overridesJson = validated.patch
      ? (() => {
          const merged = mergeOverrides(null, validated.patch);
          return merged ? JSON.stringify(merged) : null;
        })()
      : null;

    db.prepare(
      `INSERT INTO tasks (id, title, description, assigned_agent_id, project_path, priority, task_size, task_number, repository_url, repository_urls, settings_overrides, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, title, description ?? null, assigned_agent_id ?? null, project_path ?? null, priority, task_size, taskNumber, primaryRepoUrl, urlsJson, overridesJson, now, now);
    logRepositoryAutoDetectWarning(db, id, project_path ?? null, primaryRepoUrl);

    let task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task;
    ws.broadcast("task_update", buildTaskSummaryUpdate(task, { db }));

    task = autoDispatchTask(db, ws, id, {
      autoAssign: AUTO_ASSIGN_TASK_ON_CREATE,
      autoRun: AUTO_RUN_TASK_ON_CREATE,
      spawnAgent: taskSpawner,
    }) as Task;
    res.status(201).json(task);
  });

  router.put("/tasks/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "not_found" });

    const parsed = UpdateTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const updates = parsed.data;
    const existingTask = existing as unknown as Task;

    if (updates.title !== undefined && isUuidLikeTitle(updates.title)) {
      return res.status(400).json({
        error: "invalid_title",
        message: "Title must not be a machine-generated UUID placeholder",
      });
    }

    // Validate + apply settings_overrides patch. We merge (not replace)
    // so callers can flip a single toggle without having to round-trip
    // the full overrides blob. `null` value removes a key (see
    // mergeOverrides).
    if (updates.settings_overrides !== undefined) {
      const validatedUpdate = validateOverridesPatch(updates.settings_overrides);
      if (!validatedUpdate.ok) {
        return res.status(400).json({
          error: "invalid_settings_overrides",
          message: `Unknown override keys: ${validatedUpdate.invalidKeys.join(", ")}`,
          allowed_keys: TASK_OVERRIDABLE_KEYS,
        });
      }
      // Merge into existing settings_overrides and write back through
      // the generic field loop below.
      const existingRaw = (existing as { settings_overrides: string | null }).settings_overrides;
      const merged = mergeOverrides(existingRaw, validatedUpdate.patch ?? {});
      (updates as Record<string, unknown>).settings_overrides = merged ? JSON.stringify(merged) : null;
    }

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
    const shouldWarnRepositoryAutoDetect =
      updates.project_path !== undefined &&
      updates.project_path !== existingTask.project_path &&
      updates.repository_url === null;

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
    if (shouldWarnRepositoryAutoDetect) {
      logRepositoryAutoDetectWarning(db, task.id, task.project_path, task.repository_url);
    }
    if (task.directive_id && task.controller_stage) {
      reconcileControllerDirective(ctx, task.directive_id);
    }
    ws.broadcast("task_update", buildTaskSummaryUpdate(task, { db }));

    // Trigger auto-QA on manual status change to qa_testing
    if (updates.status === "qa_testing") {
      setTimeout(() => triggerAutoQa(db, ws, task), 500);
    }

    // Trigger auto-review on manual status change to pr_review
    if (updates.status === "pr_review") {
      setTimeout(() => triggerAutoReview(db, ws, task), 500);
    }

    res.json(task);
  });

  router.delete("/tasks/:id", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    // Kill any active agent process regardless of task.status. Previously
    // we only killed on in_progress, but refinement / pr_review /
    // qa_testing / test_generation all run child processes
    // too. Leaving them alive after DELETE caused FOREIGN KEY violations
    // when the child's next stdout chunk tried to insert a task_log
    // referencing the now-deleted task id, crashing the server.
    killAgent(task.id);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(req.params.id);
    // Release any agent whose `current_task_id` still pointed at this task.
    // `agents.current_task_id` has no FK cascade, so without this cleanup an
    // agent could remain `working` forever, blocking auto-dispatch.
    releaseAgentsForDeletedTask(db, ws, task.id);
    res.json({ deleted: true });
  });

  // GET /tasks/:id/settings — return overrides + the allow-list of keys
  router.get("/tasks/:id/settings", (req, res) => {
    const t0 = performance.now();
    const task = db
      .prepare("SELECT settings_overrides FROM tasks WHERE id = ?")
      .get(req.params.id) as { settings_overrides: string | null } | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const overrides = safeParseOverrides(task.settings_overrides) ?? {};
    sendMeasuredJson(res, "/tasks/:id/settings", t0, {
      task_id: req.params.id,
      overrides,
      allowed_keys: TASK_OVERRIDABLE_KEYS,
    });
  });

  // PUT /tasks/:id/settings — merge a patch of {key: value|null} into
  // tasks.settings_overrides. `null` removes a key. Unknown keys are
  // rejected so typos cannot silently create dead config.
  router.put("/tasks/:id/settings", (req, res) => {
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
      .prepare("SELECT settings_overrides, status FROM tasks WHERE id = ?")
      .get(req.params.id) as { settings_overrides: string | null; status: string } | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const merged = mergeOverrides(task.settings_overrides, parsed.data);
    const serialized = merged ? JSON.stringify(merged) : null;
    const now = Date.now();
    db.prepare("UPDATE tasks SET settings_overrides = ?, updated_at = ? WHERE id = ?").run(
      serialized,
      now,
      req.params.id,
    );

    res.json({ task_id: req.params.id, overrides: merged ?? {} });
  });

  // DELETE /tasks/:id/settings — clear all overrides for a task
  router.delete("/tasks/:id/settings", (req, res) => {
    const task = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(req.params.id) as { id: string; status: string } | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const now = Date.now();
    db.prepare("UPDATE tasks SET settings_overrides = NULL, updated_at = ? WHERE id = ?").run(now, req.params.id);
    res.json({ task_id: req.params.id, overrides: {} });
  });

  // PATCH /tasks/:id/acceptance-criterion — toggle the N-th GFM checkbox
  // in the refinement_plan. Only permitted during pr_review so reviewers
  // can mark criteria as verified without letting any other stage mutate
  // the plan text (refinement finalization owns the full rewrite path).
  router.patch("/tasks/:id/acceptance-criterion", (req, res) => {
    const BodySchema = z.object({
      index: z.number().int().nonnegative(),
      checked: z.boolean(),
    });
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { index, checked } = parsed.data;

    const task = db
      .prepare("SELECT id, status, refinement_plan FROM tasks WHERE id = ?")
      .get(req.params.id) as
      | { id: string; status: string; refinement_plan: string | null }
      | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status !== "pr_review") {
      return res.status(409).json({
        error: "not_in_pr_review",
        current_status: task.status,
      });
    }
    if (!task.refinement_plan) {
      return res.status(400).json({ error: "no_refinement_plan" });
    }

    const total = countAcceptanceCriteria(task.refinement_plan);
    const { text } = setAcceptanceCriterionChecked(task.refinement_plan, index, checked);
    if (!text) {
      return res
        .status(400)
        .json({ error: "checkbox_index_out_of_range", index, total });
    }

    const now = Date.now();
    db.prepare(
      "UPDATE tasks SET refinement_plan = ?, updated_at = ? WHERE id = ?",
    ).run(text, now, task.id);
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
    ).run(
      task.id,
      `Acceptance criterion #${index + 1} ${checked ? "checked" : "unchecked"} during pr_review.`,
    );

    const updated = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    ws.broadcast("task_update", buildTaskSummaryUpdate(updated, { db }));
    res.json({ task: updated, index, checked, total });
  });

  // Run a task (spawn agent)
  router.post("/tasks/:id/run", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status === "in_progress") return res.status(409).json({ error: "already_running" });

    // Dependency + file-conflict gate: a task whose prerequisite is
    // still active (in_progress, refinement, pr_review, …) must not
    // advance, and a task whose planned_files overlap with another
    // actively-editing task must not start in parallel — both cases
    // can edit overlapping files. The auto-dispatcher enforces this
    // for the inbox path; apply the same rule here so manual Run
    // cannot bypass the guard.
    const blockers = collectAllBlockers(db, task);
    if (isBlocked(blockers)) {
      return res.status(409).json({
        error: "blocked_by_dependencies",
        message: `Blocked: ${formatAllBlockers(blockers)}`,
        blocked_by: blockers.dependencies,
        file_conflicts: blockers.fileConflicts,
      });
    }

    const resolution = resolveImplementerAgentForExecution(
      db,
      task.assigned_agent_id,
      (req.body as { agent_id?: string }).agent_id,
      { taskId: task.id },
    );
    if (!resolution.ok) {
      if (resolution.error === "agent_not_found") return res.status(404).json({ error: "agent_not_found" });
      if (resolution.error === "agent_busy") return res.status(409).json({ error: "agent_busy" });
      if (resolution.error === "non_implementer_agent") {
        return res.status(409).json({ error: "non_implementer_agent", message: "Requested agent cannot run implementer work" });
      }
      return res.status(409).json({ error: "no_implementer_available" });
    }

    const agent = resolution.agent;

    if (task.assigned_agent_id !== agent.id) {
      db.prepare("UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(agent.id, Date.now(), task.id);
    }

    // Manual Run is an explicit user intent — reset any prior orphan-recovery
    // auto-respawn history so the task gets a fresh budget from zero.
    db.prepare("UPDATE tasks SET auto_respawn_count = 0 WHERE id = ?").run(task.id);

    try {
      const result = await taskSpawner(db, ws, agent, { ...task, assigned_agent_id: agent.id, auto_respawn_count: 0 }, {});
      res.json({ started: true, pid: result.pid });
    } catch (error) {
      const handled = handleSpawnFailure(db, ws, task.id, error, {
        source: "Manual run",
      });
      if (handled.handled) {
        return res.status(409).json({ error: handled.code, message: handled.message });
      }
      return res.status(500).json({ error: "spawn_failed", message: formatSpawnFailureForUser(error) });
    }
  });

  // Stop a running task
  router.post("/tasks/:id/stop", (req, res) => {
    const killed = killAgent(req.params.id, "user_stop");
    if (!killed) return res.status(404).json({ error: "not_running" });

    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, req.params.id);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (task?.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL, updated_at = ? WHERE id = ?").run(now, task.assigned_agent_id);
      ws.broadcast("agent_status", { id: task.assigned_agent_id, status: "idle", current_task_id: null });
    }

    ws.broadcast("task_update", { id: req.params.id, status: "cancelled" });
    res.json({ stopped: true });
  });

  // Resume a cancelled task: re-assign agent and spawn back to in_progress
  router.post("/tasks/:id/resume", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    if (task.status !== "cancelled") return res.status(409).json({ error: "not_cancelled" });

    // Dependency + file-conflict gate — see POST /tasks/:id/run for
    // rationale. Resume re-enters in_progress, so it must observe the
    // same prerequisite state as a fresh dispatch.
    const resumeBlockers = collectAllBlockers(db, task);
    if (isBlocked(resumeBlockers)) {
      return res.status(409).json({
        error: "blocked_by_dependencies",
        message: `Blocked: ${formatAllBlockers(resumeBlockers)}`,
        blocked_by: resumeBlockers.dependencies,
        file_conflicts: resumeBlockers.fileConflicts,
      });
    }

    const resolution = resolveImplementerAgentForExecution(
      db,
      task.assigned_agent_id,
      (req.body as { agent_id?: string }).agent_id,
      { taskId: task.id },
    );
    if (!resolution.ok) {
      if (resolution.error === "agent_not_found") return res.status(404).json({ error: "agent_not_found" });
      if (resolution.error === "agent_busy") return res.status(409).json({ error: "agent_busy" });
      if (resolution.error === "non_implementer_agent") {
        return res.status(409).json({ error: "non_implementer_agent", message: "Requested agent cannot run implementer work" });
      }
      return res.status(409).json({ error: "no_implementer_available" });
    }

    const agent = resolution.agent;

    const now = Date.now();
    db.prepare(
      "UPDATE tasks SET status = 'in_progress', completed_at = NULL, assigned_agent_id = ?, updated_at = ? WHERE id = ?"
    ).run(agent.id, now, task.id);

    const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    ws.broadcast("task_update", { id: task.id, status: "in_progress" });
    try {
      const result = await taskSpawner(db, ws, agent, freshTask, {});
      res.json({ resumed: true, pid: result.pid });
    } catch (error) {
      const handled = handleSpawnFailure(db, ws, task.id, error, {
        source: "Manual resume",
      });
      if (handled.handled) {
        return res.status(409).json({ error: handled.code, message: handled.message });
      }
      return res.status(500).json({ error: "spawn_failed", message: formatSpawnFailureForUser(error) });
    }
  });

  // Approve a task in human_review or refinement — advance to next stage
  router.post("/tasks/:id/approve", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const approvableStatuses = ["human_review", "refinement"];
    if (!approvableStatuses.includes(task.status)) {
      return res.status(400).json({ error: "not_in_approvable_status", current_status: task.status });
    }

    const isRefinement = task.status === "refinement";
    const workflow = loadProjectWorkflow(task.project_path);
    const activeStages = resolveActiveStages(db, workflow, task.task_size, task.id);
    const next = nextStage(task.status as "human_review" | "refinement", activeStages);
    const now = Date.now();

    // Dependency + file-conflict gate on refinement → in_progress
    // advancement. The refinement stage itself is read-only so it was
    // fine to run while a prerequisite was in_progress, but once we
    // advance to implementation the editing-conflict risk applies.
    // Block the advancement and park the task back in inbox so the
    // auto-dispatcher can pick it up the moment the prerequisite
    // finishes — matches the behavior of POST /run and auto-dispatch.
    if (isRefinement && next === "in_progress") {
      const approveBlockers = collectAllBlockers(db, task);
      if (isBlocked(approveBlockers)) {
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
          `Refinement plan approved but advancement blocked (${formatAllBlockers(approveBlockers)}). Returned to inbox for auto-dispatch to retry when prerequisites finish.`,
        );

        ws.broadcast("task_update", { id: task.id, status: "inbox", assigned_agent_id: null, started_at: null });

        return res.status(409).json({
          error: "blocked_by_dependencies",
          message: `Refinement approved but blocked: ${formatAllBlockers(approveBlockers)}`,
          blocked_by: approveBlockers.dependencies,
          file_conflicts: approveBlockers.fileConflicts,
          returned_to: "inbox",
        });
      }
    }

    const taskControllerMode = isTaskControllerModeEnabled(db, task.id);
    if (isRefinement && next === "in_progress" && taskControllerMode) {
      const splitResult = splitRefinementPlanIntoTasks(ctx, task, { controllerMode: taskControllerMode });
      if (!("error" in splitResult)) {
        setTimeout(() => {
          for (const child of splitResult.children) {
            autoDispatchTask(db, ws, child.id, { autoAssign: true, autoRun: true });
          }
        }, 500);

        return res.json({
          approved: true,
          next_status: "done",
          controller_mode: true,
          directive_id: splitResult.directiveId,
          children_count: splitResult.children.length,
          children: splitResult.children.map((child) => ({
            id: child.id,
            task_number: child.task_number,
            controller_stage: child.controller_stage,
          })),
          plan_path: splitResult.planPath,
        });
      }

      return res.status(400).json({
        error: splitResult.error,
        message: splitResult.message,
        step: splitResult.step,
      });
    }

    let approvedTaskForSpawn: Task | undefined;
    let approvedAgentForSpawn: Agent | undefined;

    if (isRefinement && next === "in_progress") {
      const resolution = resolveImplementerAgentForExecution(db, task.assigned_agent_id, undefined, {
        taskId: task.id,
        excludeIds: [task.assigned_agent_id],
      });

      if (!resolution.ok) {
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
          "Refinement plan approved but no runnable implementer is available. Returned to inbox for auto-dispatch retry.",
        );

        ws.broadcast("task_update", { id: task.id, status: "inbox", assigned_agent_id: null, started_at: null });

        return res.json({
          approved: true,
          deferred: true,
          reason: "no_implementer_available",
          next_status: "inbox",
          returned_to: "inbox",
        });
      }

      approvedAgentForSpawn = resolution.agent;
      db.prepare("UPDATE tasks SET status = ?, assigned_agent_id = ?, updated_at = ? WHERE id = ?")
        .run(next, approvedAgentForSpawn.id, now, task.id);
    } else {
      db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(next, now, task.id);
    }

    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `${isRefinement ? "Refinement plan" : "Human review"} approved. Advancing to ${next}.`);
    if (!isRefinement) {
      recordHumanReviewAutoMarker(db, task.id, "CLEARED", "Approved by human reviewer.");
    }

    const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    approvedTaskForSpawn = updatedTask;
    ws.broadcast("task_update", buildTaskSummaryUpdate(updatedTask, { db }));

    // After refinement approval → auto-dispatch to in_progress if agent is idle
    if (isRefinement && next === "in_progress" && approvedAgentForSpawn && approvedTaskForSpawn) {
      const agent = approvedAgentForSpawn;
      if (isRunnableImplementerAgent(agent)) {
        setTimeout(() => {
          taskSpawner(db, ws, agent, approvedTaskForSpawn, {}).catch((err) => {
            const handled = handleSpawnFailure(db, ws, updatedTask.id, err, {
              source: "Refinement approval auto-run",
            });
            if (handled.handled) {
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[tasks.approve] spawnAgent failed for task ${updatedTask.id}:`, err);
            try {
              db.prepare(
                "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
              ).run(updatedTask.id, `spawnAgent failed: ${message}`);
            } catch {
              // swallow logging failure — we must not re-throw inside setTimeout
            }
          });
        }, 500);
      }
    }

    res.json({ approved: true, next_status: next });
  });

  // Reject a task in human_review or refinement — send back to inbox
  router.post("/tasks/:id/reject", (req, res) => {
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
    if (!isRefinement) {
      recordHumanReviewAutoMarker(db, task.id, "CLEARED", "Rejected by human reviewer.");
    }
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `${isRefinement ? "Refinement plan" : "Human review"} rejected: ${reason}. Returning to inbox.`);

    ws.broadcast("task_update", { id: task.id, status: "inbox", assigned_agent_id: null, started_at: null });

    res.json({ rejected: true, reason });
  });

  // Split a refinement plan into individual tasks
  router.post("/tasks/:id/split", (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });
    const taskControllerMode = isTaskControllerModeEnabled(db, task.id);
    const splitResult = splitRefinementPlanIntoTasks(ctx, task, { controllerMode: taskControllerMode });
    if ("error" in splitResult) {
      return res.status(400).json({
        error: splitResult.error,
        message: splitResult.message,
        step: splitResult.step,
      });
    }

    setTimeout(() => {
      const runnableChildren = taskControllerMode
        ? splitResult.children.filter((child) => child.controller_stage === "implement")
        : splitResult.children.filter((child) => !child.depends_on);
      for (const child of runnableChildren) {
        autoDispatchTask(db, ws, child.id, { autoAssign: true, autoRun: true });
      }
    }, 500);

    res.json({
      parent: splitResult.parent,
      children: splitResult.children,
      plan_path: splitResult.planPath,
      directive_id: splitResult.directiveId,
      controller_mode: splitResult.directiveId !== null,
    });
  });

  // Get task logs
  //
  // Query params:
  //   - `limit` (default 200, max 1000)
  //   - `since_id` (optional): incremental tail fetch — returns rows with
  //     `id > since_id` ordered ASC, capped at `limit`. Stage-transition
  //     fold-in is skipped on this path. Callers must loop until the
  //     returned page length is `< limit` to fully drain a backlog.
  //   - `offset` (default 0): legacy DESC-ordered pagination — returns the
  //     newest `limit` rows skipping `offset`, plus a stage-transition
  //     fold-in so the rendered timeline always opens with a stage marker.
  router.get("/tasks/:id/logs", (req, res) => {
    const t0 = performance.now();
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const sinceId = req.query.since_id ? Number(req.query.since_id) : null;

    let logs: Array<Record<string, unknown> & { id: number; message: string }>;

    if (sinceId != null && Number.isFinite(sinceId)) {
      logs = db.prepare(
        "SELECT * FROM task_logs WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?"
      ).all(req.params.id, sinceId, limit) as Array<Record<string, unknown> & { id: number; message: string }>;
    } else {
      const offset = Number(req.query.offset ?? 0);
      logs = db.prepare(
        "SELECT * FROM task_logs WHERE task_id = ? ORDER BY id DESC LIMIT ? OFFSET ?"
      ).all(req.params.id, limit, offset) as Array<Record<string, unknown> & { id: number; message: string }>;

      // Stage transition markers are inserted by the DB trigger on every
      // status change. For a paginated initial fetch we only need the newest
      // transition immediately before the oldest row in the window; older
      // markers do not affect the stage grouping for the current page and
      // would bloat the payload on long-lived tasks.
      const oldestFetchedId = logs[logs.length - 1]?.id;
      if (oldestFetchedId != null) {
        const boundaryTransition = db.prepare(
          "SELECT * FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE ? AND id < ? ORDER BY id DESC LIMIT 1"
        ).get(
          req.params.id,
          `${STAGE_TRANSITION_MESSAGE_PREFIX}%`,
          oldestFetchedId,
        ) as (Record<string, unknown> & { id: number; message: string }) | undefined;

        if (boundaryTransition) {
          logs.push(boundaryTransition);
          logs.sort((a, b) => Number(b.id) - Number(a.id));
        }
      }
    }

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
    sendMeasuredJson(res, "/tasks/:id/logs", t0, truncated);
  });

  // CEO Feedback: send directive to a task (in_progress or finished)
  router.post("/tasks/:id/feedback", async (req, res) => {
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id) as Task | undefined;
    if (!task) return res.status(404).json({ error: "not_found" });

    const parsed = parseFeedbackRequest(req.body);
    if (!parsed.ok) {
      return res.status(400).json({
        error: "invalid_feedback",
        message: parsed.message,
        details: parsed.details,
      });
    }

    const { content } = parsed;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    // 1. Append to feedback file
    const feedbackDir = process.env.AO_FEEDBACK_DIR ?? join("data", "feedback");
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
    const isRefinementRevision = previousStatus === "refinement";

    if (isRefinementRevision) {
      markRefinementRevisionRequested(db, task.id, now);
    }

    let refinementTransitionDone = false;

    if (task.status === "in_progress" || task.status === "refinement") {
      if (processActive(task.id)) {
        const preflightError = createFeedbackResumePreflightError(db, task);
        if (preflightError) {
          const resolution = `Feedback resume: ${preflightError.message}`;
          db.prepare(
            "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)",
          ).run(task.id, resolution);
          ws.broadcast(
            "cli_output",
            { task_id: task.id, kind: "system", message: resolution },
            { taskId: task.id },
          );
          return res.json({
            sent: true,
            restarted: false,
            feedback_path: feedbackPath,
            error: preflightError.code,
            resolution,
          });
        }
      }

      // Running refinement: log the inbox round-trip before killing
      if (task.status === "refinement") {
        db.prepare("UPDATE tasks SET status = 'inbox', completed_at = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
        db.prepare(
          "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
        ).run(task.id, `[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.`);
        db.prepare("UPDATE tasks SET status = 'refinement', updated_at = ? WHERE id = ?").run(now, task.id);
        refinementTransitionDone = true;
      }
      // Running task: kill + respawn with --resume
      const restarted = feedbackRestarter(task.id, content, previousStatus);
      if (restarted) {
        if (isRefinementRevision) {
          const freshTask = fetchTaskById(db, task.id);
          if (freshTask) {
            ws.broadcast("task_update", buildTaskSummaryUpdate(freshTask, { db }));
          }
        }
        return res.json({ sent: true, restarted, feedback_path: feedbackPath });
      }
      // Process already exited — fall through to idle-agent respawn below
    }

    // Agent process not running: respawn idle agent with --resume
    let agent: Agent | undefined;
    if (previousStatus === "refinement") {
      const agentId = task.assigned_agent_id;
      if (!agentId) {
        if (isRefinementRevision) {
          const freshTask = fetchTaskById(db, task.id);
          if (freshTask) {
            ws.broadcast("task_update", buildTaskSummaryUpdate(freshTask, { db }));
          }
        }
        return res.json({ sent: true, restarted: false, feedback_path: feedbackPath });
      }

      agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Agent | undefined;
      if (!agent || agent.status === "working") {
        if (isRefinementRevision) {
          const freshTask = fetchTaskById(db, task.id);
          if (freshTask) {
            ws.broadcast("task_update", buildTaskSummaryUpdate(freshTask, { db }));
          }
        }
        return res.json({ sent: true, restarted: false, feedback_path: feedbackPath });
      }
    } else if (isGuardedStage(previousStatus)) {
      const resolution = resolveAgentForResume(db, task, previousStatus);
      if (!resolution.ok) {
        return res.json({ sent: true, restarted: false, feedback_path: feedbackPath, resolution: resolution.error });
      }
      agent = resolution.agent;
    } else {
      const resolution = resolveImplementerAgentForExecution(db, task.assigned_agent_id, undefined, {
        taskId: task.id,
      });
      if (!resolution.ok) {
        return res.json({ sent: true, restarted: false, feedback_path: feedbackPath, resolution: resolution.error });
      }
      agent = resolution.agent;
    }
    if (!agent) {
      return res.json({ sent: true, restarted: false, feedback_path: feedbackPath });
    }

    // Refinement revise: transition through inbox so the stage_transition
    // trigger logs both refinement→inbox and inbox→refinement with timestamps.
    // Skip when the running-process path above already recorded the transition
    // (queueFeedbackAndRestart returned false → fell through here).
    if (previousStatus === "refinement") {
      if (!refinementTransitionDone) {
        db.prepare("UPDATE tasks SET status = 'inbox', completed_at = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
        db.prepare(
          "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
        ).run(task.id, `[Revise] Refinement plan revision requested. Returning to inbox before re-entering refinement.`);
        db.prepare("UPDATE tasks SET status = 'refinement', updated_at = ? WHERE id = ?").run(now, task.id);
      }
    } else if (isGuardedStage(previousStatus)) {
      db.prepare(
        "UPDATE tasks SET completed_at = NULL, auto_respawn_count = 0, updated_at = ? WHERE id = ?",
      ).run(now, task.id);
      ws.broadcast("task_update", { id: task.id, status: previousStatus, assigned_agent_id: task.assigned_agent_id });
    } else {
      // Manual feedback-rework is an explicit user intent — reset the
      // auto-respawn counter so a mid-rework crash gets a full retry budget.
      db.prepare(
        "UPDATE tasks SET status = 'in_progress', completed_at = NULL, assigned_agent_id = ?, auto_respawn_count = 0, updated_at = ? WHERE id = ?",
      ).run(agent.id, now, task.id);
      ws.broadcast("task_update", { id: task.id, status: "in_progress", assigned_agent_id: agent.id });
    }

    const freshTask = fetchTaskById(db, task.id) as Task;
    if (previousStatus === "refinement") {
      ws.broadcast("task_update", buildTaskSummaryUpdate(freshTask, { db }));
    }
    try {
      await taskSpawner(db, ws, agent, freshTask, { continuePrompt: content, previousStatus });
    } catch (err) {
      const handled = handleSpawnFailure(db, ws, task.id, err, {
        source: "Feedback resume",
      });
      if (handled.handled) {
        return res.json({
          sent: true,
          restarted: false,
          feedback_path: feedbackPath,
          error: handled.code,
          resolution: handled.message,
        });
      }
      console.error(`[tasks.feedback] spawnAgent failed for task ${task.id}:`, err);
      return res.status(500).json({
        sent: true,
        restarted: false,
        feedback_path: feedbackPath,
        error: "spawn_failed",
        message: formatSpawnFailureForUser(err),
      });
    }

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

    const resumeStage = pending.spawnStage ?? task.status;
    const resolution = resolveAgentForResume(db, task, resumeStage, pending.runnerAgentId);
    if (!resolution.ok) {
      return res.json({ sent: true, restarted: false, resolution: resolution.error });
    }

    const agent = resolution.agent;

    if (isGuardedStage(resumeStage)) {
      db.prepare("UPDATE tasks SET completed_at = NULL, updated_at = ? WHERE id = ?").run(now, task.id);
      ws.broadcast("task_update", { id: task.id, status: task.status, assigned_agent_id: task.assigned_agent_id });
    } else {
      // Ensure task is in_progress for normal implementer resumes.
      db.prepare("UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(agent.id, now, task.id);
      ws.broadcast("task_update", { id: task.id, status: "in_progress", assigned_agent_id: agent.id });
    }

    const freshTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
    taskSpawner(db, ws, agent, freshTask, {
      continuePrompt,
      previousStatus: resolution.previousStatus,
      finalizeOnComplete: true,
      reviewerRole: pending.reviewerRole,
      parallelTester: pending.parallelTester,
    }).catch((err) => {
      const handled = handleSpawnFailure(db, ws, task.id, err, {
        source: "Interactive prompt resume",
      });
      if (handled.handled) {
        return;
      }
      console.error(`[tasks.interactive-response] spawnAgent failed for task ${task.id}:`, err);
    });

    res.json({ sent: true, restarted: true });
  });

  return router;
}
