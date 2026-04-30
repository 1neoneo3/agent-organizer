import type { DatabaseSync } from "node:sqlite";
import { spawnAgent as defaultSpawnAgent } from "../spawner/process-manager.js";
import { handleSpawnFailure } from "../spawner/spawn-failures.js";
import type { Agent, Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { pickTaskUpdate } from "../ws/update-payloads.js";
import { getMaxReviewCount, hasExhaustedReviewBudget } from "../domain/review-rules.js";
import { normalizePath, parsePlannedFiles } from "../domain/planned-files.js";

interface AutoDispatchOptions {
  autoAssign: boolean;
  autoRun: boolean;
  spawnAgent?: typeof defaultSpawnAgent;
}

interface GitHubInboxConflict {
  task_number: string;
  status: string;
  matching_paths: string[];
  matching_terms: string[];
}

interface TaskSignals {
  paths: string[];
  terms: string[];
}

const ACTIVE_EDITING_STATUSES = new Set([
  "refinement",
  "in_progress",
  "test_generation",
  "qa_testing",
  "pr_review",
  "human_review",
]);

const GITHUB_CONFLICT_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "api",
  "by",
  "bug",
  "change",
  "create",
  "github",
  "fix",
  "for",
  "from",
  "gh",
  "implementation",
  "implement",
  "in",
  "issue",
  "into",
  "new",
  "on",
  "or",
  "problem",
  "request",
  "sync",
  "task",
  "the",
  "to",
  "update",
  "with",
]);

const GITHUB_CONFLICT_HIGH_SIGNAL_TERMS = new Set([
  "auth",
  "cache",
  "ci",
  "cd",
  "css",
  "database",
  "deploy",
  "e2e",
  "frontend",
  "infra",
  "login",
  "logout",
  "migration",
  "node",
  "notification",
  "oauth",
  "payment",
  "playwright",
  "permission",
  "refactor",
  "react",
  "review",
  "route",
  "schema",
  "security",
  "test",
  "typescript",
  "ui",
  "ux",
  "webhook",
  "xss",
]);

const PATH_CANDIDATE_RE = /(?:\.{1,2}\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\.[A-Za-z0-9._-]+)?/g;
const WORD_TOKEN_RE = /[A-Za-z0-9]+/g;

function writeAutoDispatchLog(db: DatabaseSync, task: Task, message: string): void {
  const fullMessage = `[Auto Dispatch] ${message}`;

  try {
    const lastLog = db.prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' ORDER BY id DESC LIMIT 1"
    ).get(task.id) as { message: string } | undefined;

    if (lastLog?.message === fullMessage) {
      return;
    }

    const now = Date.now();
    db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)")
      .run(task.id, fullMessage);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(now, task.id);
  } catch (error) {
    if (!error || typeof error !== "object" || (error as { errcode?: unknown }).errcode !== 787) {
      throw error;
    }
  }
}

function normalizeConflictTerm(term: string): string {
  const lowered = term.trim().toLowerCase();
  if (lowered.length === 0) return lowered;
  if (lowered.endsWith("ies") && lowered.length > 4) {
    return `${lowered.slice(0, -3)}y`;
  }
  if (lowered.endsWith("s") && lowered.length > 3 && !lowered.endsWith("ss")) {
    return lowered.slice(0, -1);
  }
  return lowered;
}

function collectTaskSignals(task: Pick<Task, "title" | "description" | "planned_files">): TaskSignals {
  const text = `${task.title}\n${task.description ?? ""}`;
  const paths = new Set<string>(parsePlannedFiles(task.planned_files));
  const terms = new Set<string>();

  for (const rawPath of text.match(PATH_CANDIDATE_RE) ?? []) {
    if (/^https?:\/\//i.test(rawPath) || /github\.com\//i.test(rawPath)) {
      continue;
    }
    const normalized = normalizePath(rawPath);
    if (normalized.length > 0) {
      paths.add(normalized);
    }
  }

  for (const rawToken of text.match(WORD_TOKEN_RE) ?? []) {
    const normalized = normalizeConflictTerm(rawToken);
    if (normalized.length < 3 || GITHUB_CONFLICT_STOP_WORDS.has(normalized)) {
      continue;
    }
    terms.add(normalized);
  }

  return {
    paths: [...paths],
    terms: [...terms],
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function findSharedPaths(left: string[], right: string[]): string[] {
  const overlap = new Set<string>();
  for (const candidate of left) {
    if (right.some((other) => pathsOverlap(candidate, other))) {
      overlap.add(candidate);
    }
  }
  return [...overlap].sort();
}

function findSharedTerms(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((term) => rightSet.has(term));
}

export function getGitHubInboxConflicts(db: DatabaseSync, task: Task): GitHubInboxConflict[] {
  if (task.external_source !== "github" || task.status !== "inbox" || !task.project_path) {
    return [];
  }

  const currentSignals = collectTaskSignals(task);
  if (currentSignals.paths.length === 0 && currentSignals.terms.length === 0) {
    return [];
  }

  const activeRows = db.prepare(
    `SELECT id, task_number, status, title, description, planned_files
     FROM tasks
     WHERE id != ?
       AND project_path = ?
       AND status IN (?, ?, ?, ?, ?, ?)`
  ).all(
    task.id,
    task.project_path,
    ...Array.from(ACTIVE_EDITING_STATUSES),
  ) as Array<{
    id: string;
    task_number: string | null;
    status: string;
    title: string;
    description: string | null;
    planned_files: string | null;
  }>;

  const conflicts: GitHubInboxConflict[] = [];
  for (const row of activeRows) {
    const activeSignals = collectTaskSignals(row);
    const matchingPaths = findSharedPaths(currentSignals.paths, activeSignals.paths);
    const matchingTerms = findSharedTerms(currentSignals.terms, activeSignals.terms);
    const hasHighSignalTerm = matchingTerms.some((term) => GITHUB_CONFLICT_HIGH_SIGNAL_TERMS.has(term));

    if (matchingPaths.length === 0 && matchingTerms.length < 2 && !hasHighSignalTerm) {
      continue;
    }

    conflicts.push({
      task_number: row.task_number ?? row.id,
      status: row.status,
      matching_paths: matchingPaths,
      matching_terms: matchingTerms,
    });
  }

  return conflicts;
}

export function formatGitHubInboxConflicts(conflicts: GitHubInboxConflict[]): string {
  return conflicts
    .map((conflict) => {
      const parts: string[] = [];
      if (conflict.matching_paths.length > 0) {
        parts.push(`paths: ${conflict.matching_paths.join(", ")}`);
      }
      if (conflict.matching_terms.length > 0) {
        parts.push(`keywords: ${conflict.matching_terms.join(", ")}`);
      }
      return `${conflict.task_number} (${conflict.status})${parts.length > 0 ? ` → ${parts.join("; ")}` : ""}`;
    })
    .join("; ");
}

export function pickIdleAgent(db: DatabaseSync): Agent | undefined {
  return db.prepare(
    `SELECT * FROM agents
     WHERE status = 'idle' AND current_task_id IS NULL
     ORDER BY stats_tasks_done ASC, updated_at ASC
     LIMIT 1`
  ).get() as Agent | undefined;
}

export function autoDispatchTask(
  db: DatabaseSync,
  ws: WsHub,
  taskId: string,
  options: AutoDispatchOptions,
): Task | undefined {
  const spawnAgent = options.spawnAgent ?? defaultSpawnAgent;
  let task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as Task | undefined;
  if (!task) return undefined;

  // Skip tasks that were returned to inbox after hitting review_count max.
  // Without this guard, periodic dispatch re-picks them and creates an infinite
  // pr_review → inbox → dispatch → pr_review loop with repeated Telegram notifications.
  if (task.status === "inbox" && task.review_count > 0) {
    if (hasExhaustedReviewBudget(task, getMaxReviewCount(db))) {
      return task;
    }
  }

  const githubConflicts = getGitHubInboxConflicts(db, task);
  if (githubConflicts.length > 0) {
    writeAutoDispatchLog(
      db,
      task,
      `blocked (github sync conflicts: ${formatGitHubInboxConflicts(githubConflicts)})`,
    );
    return task;
  }

  if (!task.assigned_agent_id && options.autoAssign) {
    const idleAgent = pickIdleAgent(db);
    if (idleAgent) {
      const assignTs = Date.now();
      db.prepare("UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?").run(idleAgent.id, assignTs, task.id);
      task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
      if (task) {
        ws.broadcast("task_update", pickTaskUpdate(task, ["assigned_agent_id", "updated_at"]));
      }
    }
  }

  if (!task?.assigned_agent_id || !options.autoRun || task.status === "in_progress") {
    return task;
  }

  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as Agent | undefined;
  if (!agent || agent.status !== "idle") {
    return task;
  }

  // Fire-and-forget: spawnAgent is async (awaits the Explore Phase) but
  // autoDispatchTask returns synchronously so callers can read the updated
  // task row immediately.
  const spawnResult = spawnAgent(db, ws, agent, task);
  if (spawnResult && typeof (spawnResult as Promise<unknown>).catch === "function") {
    (spawnResult as Promise<unknown>).catch((err) => {
      const handled = handleSpawnFailure(db, ws, task.id, err, {
        source: "Auto dispatch",
      });
      if (handled.handled) {
        return;
      }
      console.error(`[auto-dispatch] spawnAgent failed for task ${task.id}:`, err);
    });
  }
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as Task | undefined;
}
