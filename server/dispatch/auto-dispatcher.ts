import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AUTO_DISPATCH_INTERVAL_MS } from "../config/runtime.js";
import { spawnAgent } from "../spawner/process-manager.js";
import { handleSpawnFailure } from "../spawner/spawn-failures.js";
import { resolveStageAgentOverride } from "../spawner/stage-agent-resolver.js";
import type { Agent, Task } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { loadProjectWorkflow } from "../workflow/loader.js";
import { resolveActiveStages } from "../workflow/stage-pipeline.js";
import {
  collectAllBlockers,
  formatAllBlockers,
  isBlocked,
} from "../domain/task-dependencies.js";
import {
  formatGitHubInboxConflicts,
  getGitHubInboxConflicts,
} from "../tasks/auto-dispatch.js";

export type AutoDispatchMode = "disabled" | "github_only" | "all_inbox";

export interface AutoDispatchSummary {
  started: number;
  assigned: number;
  skipped: number;
}

interface DispatchOptions {
  startTask?: (task: Task, agent: Agent) => void;
}

const AUTO_DISPATCH_LOG_PREFIX = "[Auto Dispatch]";
const ROLE_HINTS: Record<string, string[]> = {
  tester: ["test", "tests", "testing", "qa", "spec", "e2e", "playwright", "flaky"],
  code_reviewer: ["review", "audit"],
  architect: ["architecture", "architect", "redesign", "migration"],
  security_reviewer: ["security", "auth", "oauth", "csrf", "xss", "secret", "permission", "vulnerability"],
  researcher: ["research", "investigate", "analysis", "analyze", "explore", "docs", "document"],
  devops: ["deploy", "deployment", "infra", "infrastructure", "docker", "k8s", "workflow", "ci", "cd", "cloud", "terraform"],
  designer: ["ui", "ux", "design", "visual", "layout", "css", "theme"],
  planner: ["plan", "planning", "roadmap", "breakdown", "spec"],
  lead_engineer: ["fix", "bug", "implement", "feature", "refactor", "api", "backend", "frontend", "typescript", "react", "node"],
};

function getSetting(db: DatabaseSync, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function getAutoDispatchMode(db: DatabaseSync): AutoDispatchMode {
  const raw = getSetting(db, "auto_dispatch_mode");
  if (raw === "disabled" || raw === "github_only" || raw === "all_inbox") {
    return raw;
  }
  return "github_only";
}

function getInboxTasks(db: DatabaseSync): Task[] {
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'inbox' ORDER BY priority DESC, created_at ASC"
  ).all() as unknown as Task[];
}

function getIdleWorkers(db: DatabaseSync): Agent[] {
  return db.prepare(
    "SELECT * FROM agents WHERE status = 'idle' AND agent_type = 'worker' ORDER BY stats_tasks_done DESC, created_at ASC"
  ).all() as unknown as Agent[];
}

function buildTaskSearchText(task: Task): string {
  const projectName = task.project_path ? basename(task.project_path) : "";
  return [task.title, task.description ?? "", task.project_path ?? "", projectName]
    .join(" ")
    .toLowerCase();
}

function tokenizeProjectPath(projectPath: string | null): string[] {
  if (!projectPath) return [];
  return projectPath
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function detectPreferredRoles(task: Task): string[] {
  const text = buildTaskSearchText(task);
  const scored = Object.entries(ROLE_HINTS)
    .map(([role, keywords]) => ({
      role,
      matches: keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0),
    }))
    .filter((entry) => entry.matches > 0)
    .sort((left, right) => right.matches - left.matches || left.role.localeCompare(right.role));

  return scored.map((entry) => entry.role);
}

function scoreAgentForTask(agent: Agent, task: Task, preferredRoles: string[]): number {
  const text = buildTaskSearchText(task);
  const agentText = [agent.name, agent.personality ?? "", agent.cli_model ?? ""].join(" ").toLowerCase();
  const projectTokens = tokenizeProjectPath(task.project_path);
  let score = 0;

  if (preferredRoles.length > 0) {
    const roleIndex = preferredRoles.indexOf(agent.role ?? "");
    if (roleIndex >= 0) {
      score += 120 - (roleIndex * 10);
    } else if (agent.role === "lead_engineer" || agent.role === null) {
      score += 20;
    }
  } else if (agent.role === "lead_engineer") {
    score += 60;
  } else if (agent.role === null) {
    score += 40;
  }

  if (agent.role === "lead_engineer") score += 10;
  if (task.priority >= 8) score += Math.min(agent.stats_tasks_done, 40) / 4;

  if (task.task_size === "large") {
    if (agent.role === "lead_engineer" || agent.role === "architect" || agent.role === "planner") {
      score += 20;
    }
    if (agent.cli_reasoning_level && /(high|max|deep)/i.test(agent.cli_reasoning_level)) {
      score += 10;
    }
    if (agent.cli_provider !== "codex") {
      score += 4;
    }
  }

  if (task.task_size === "small" && agent.cli_provider === "codex") {
    score += 8;
  }

  if (projectTokens.some((token) => agentText.includes(token))) {
    score += 25;
  }

  if (/\b(test|tests|spec|playwright|e2e|qa)\b/.test(text) && agent.role === "tester") score += 40;
  if (/\b(ui|ux|design|visual|layout|css|theme)\b/.test(text) && agent.role === "designer") score += 40;
  if (/\b(security|auth|oauth|csrf|xss|secret|permission)\b/.test(text) && agent.role === "security_reviewer") score += 50;
  if (/\b(deploy|infra|docker|k8s|workflow|ci|cd|cloud|terraform)\b/.test(text) && agent.role === "devops") score += 45;
  if (/\b(plan|planning|roadmap|breakdown|spec)\b/.test(text) && agent.role === "planner") score += 40;
  if (/\b(architecture|architect|redesign|migration)\b/.test(text) && agent.role === "architect") score += 45;
  if (/\b(research|investigate|analysis|analyze|explore|docs|document)\b/.test(text) && agent.role === "researcher") score += 40;

  if (/\b(test|fix|implement|api|typescript|react|node|backend|frontend)\b/.test(text) && agent.cli_provider === "codex") score += 6;
  if (/\b(research|analysis|design|plan)\b/.test(text) && agent.cli_provider === "gemini") score += 4;
  if (/\b(security|review|architecture|migration)\b/.test(text) && agent.cli_provider === "claude") score += 4;

  return score;
}

function resolveRefinementAgentForInbox(
  db: DatabaseSync,
  task: Task,
  availableAgents: Map<string, Agent>,
): Agent | undefined {
  const override = resolveStageAgentOverride(
    db,
    "refinement_agent_role",
    "refinement_agent_model",
  );
  if (!override) return undefined;
  if (!availableAgents.has(override.id)) return undefined;

  // When the task has no project_path we cannot load a project workflow,
  // so fall back to the built-in defaults (workflow = null). We never read
  // the dispatcher's own CWD: that would silently apply AO's workflow to
  // a task that belongs to an unrelated or unconfigured repo.
  let workflow = null;
  if (task.project_path) {
    try {
      workflow = loadProjectWorkflow(task.project_path);
    } catch {
      workflow = null;
    }
  }
  const activeStages = resolveActiveStages(db, workflow, task.task_size, task.id);
  if (activeStages[0] !== "refinement") return undefined;

  return override;
}

function chooseBestAgent(task: Task, agents: Agent[]): Agent | undefined {
  if (agents.length === 0) return undefined;
  const preferredRoles = detectPreferredRoles(task);

  return [...agents].sort((left, right) => {
    const scoreDiff = scoreAgentForTask(right, task, preferredRoles) - scoreAgentForTask(left, task, preferredRoles);
    if (scoreDiff !== 0) return scoreDiff;
    if (right.stats_tasks_done !== left.stats_tasks_done) {
      return right.stats_tasks_done - left.stats_tasks_done;
    }
    return left.created_at - right.created_at;
  })[0];
}

/**
 * SQLite extended error code for FOREIGN KEY constraint violations.
 * Surfaces as `errcode: 787` on the thrown DatabaseError.
 */
const SQLITE_CONSTRAINT_FOREIGNKEY = 787;

function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { errcode?: unknown }).errcode;
  return code === SQLITE_CONSTRAINT_FOREIGNKEY;
}

function writeDispatchLog(db: DatabaseSync, task: Task, message: string): void {
  const fullMessage = `${AUTO_DISPATCH_LOG_PREFIX} ${message}`;

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
    // The task may have been deleted (UI delete, github-sync close,
    // dependency cascade, manual SQL cleanup) between the inbox
    // snapshot at the top of the dispatch tick and this log write.
    // FK 787 on the task_logs INSERT is the canonical signal of that
    // race. Swallow it: crashing the whole dispatcher into systemd
    // would only delay the next tick by RestartSec while spamming the
    // journal, and the task we were trying to log against is already
    // gone — no actor remains to inform.
    if (isForeignKeyViolation(error)) {
      return;
    }
    throw error;
  }
}

function assignTaskToAgent(db: DatabaseSync, task: Task, agent: Agent): Task {
  if (task.assigned_agent_id === agent.id) {
    return task;
  }

  const now = Date.now();
  db.prepare("UPDATE tasks SET assigned_agent_id = ?, updated_at = ? WHERE id = ?")
    .run(agent.id, now, task.id);
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(task.id) as unknown as Task;
}

function createDefaultTaskStarter(
  db: DatabaseSync,
  ws: WsHub,
): (task: Task, agent: Agent) => void {
  return (task, agent) => {
    spawnAgent(db, ws, agent, task).catch((err) => {
      const handled = handleSpawnFailure(db, ws, task.id, err, {
        source: "Auto dispatcher",
      });
      if (handled.handled) {
        return;
      }
      console.error(`[auto-dispatcher] spawnAgent failed for task ${task.id}:`, err);
    });
  };
}

// Dependency-blocking logic lives in `server/domain/task-dependencies.ts`
// so every "→in_progress" entry point (auto-dispatch, manual Run, Resume,
// refinement approve) uses the same rule. The local copy that used to
// live here treated only `status = 'done'` as passing, same as the
// shared helper.

function getEligibilitySkipReason(task: Task, mode: AutoDispatchMode): string | null {
  if (mode === "all_inbox") {
    return null;
  }
  if (task.external_source !== "github") {
    return "skipped: github_only mode targets GitHub-synced tasks only";
  }
  return null;
}

export function dispatchAutoStartableTasks(
  db: DatabaseSync,
  ws: WsHub,
  options?: DispatchOptions,
): AutoDispatchSummary {
  const mode = getAutoDispatchMode(db);
  const summary: AutoDispatchSummary = { started: 0, assigned: 0, skipped: 0 };

  if (mode === "disabled") {
    return summary;
  }

  const startTask = options?.startTask ?? createDefaultTaskStarter(db, ws);
  const idleWorkers = getIdleWorkers(db);
  const availableAgents = new Map(idleWorkers.map((agent) => [agent.id, agent]));
  const inboxTasks = getInboxTasks(db);

  for (const task of inboxTasks) {
    try {
    // Combined gate: declared depends_on chain AND static file-overlap
    // (planned_files intersection with any other actively-editing task).
    // A dependency in `in_progress` / `refinement` / `pr_review` / … is
    // treated as still blocking; so is any task whose planned_files
    // overlap with ours, even without an explicit depends_on edge.
    const blockers = collectAllBlockers(db, task);
    if (isBlocked(blockers)) {
      summary.skipped += 1;
      writeDispatchLog(db, task, `blocked (${formatAllBlockers(blockers)})`);
      continue;
    }

    const githubConflicts = getGitHubInboxConflicts(db, task);
    if (githubConflicts.length > 0) {
      summary.skipped += 1;
      writeDispatchLog(db, task, `blocked (github sync conflicts: ${formatGitHubInboxConflicts(githubConflicts)})`);
      continue;
    }

    const skipReason = getEligibilitySkipReason(task, mode);
    if (skipReason) {
      summary.skipped += 1;
      writeDispatchLog(db, task, skipReason);
      continue;
    }

    if (task.assigned_agent_id) {
      const assignedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as Agent | undefined;
      if (!assignedAgent) {
        summary.skipped += 1;
        writeDispatchLog(db, task, `skipped: assigned agent "${task.assigned_agent_id}" was not found`);
        continue;
      }
      if (assignedAgent.status !== "idle") {
        summary.skipped += 1;
        writeDispatchLog(db, task, `skipped: assigned agent is not idle (${assignedAgent.name})`);
        continue;
      }

      try {
        writeDispatchLog(
          db,
          task,
          `starting with assigned agent "${assignedAgent.name}"${assignedAgent.role ? ` [${assignedAgent.role}]` : ""}`,
        );
        startTask(task, assignedAgent);
        availableAgents.delete(assignedAgent.id);
        summary.started += 1;
      } catch (error) {
        summary.skipped += 1;
        const message = error instanceof Error ? error.message : String(error);
        writeDispatchLog(db, task, `failed to start with assigned agent "${assignedAgent.name}": ${message}`);
      }
      continue;
    }

    // Stage-specific default: when the task's first active stage is
    // `refinement`, honour the stage-specific role/model selection
    // before falling back to role-based scoring. The override only
    // applies if the agent is currently idle (i.e. present in
    // `availableAgents`); otherwise we defer to `chooseBestAgent` so
    // a busy override does not starve the queue.
    const refinementOverride = resolveRefinementAgentForInbox(db, task, availableAgents);
    const selectedAgent = refinementOverride ?? chooseBestAgent(task, [...availableAgents.values()]);
    if (!selectedAgent) {
      summary.skipped += 1;
      writeDispatchLog(db, task, "skipped: no idle worker agent is available");
      continue;
    }

    const assignedTask = assignTaskToAgent(db, task, selectedAgent);

    try {
      writeDispatchLog(
        db,
        assignedTask,
        `assigned "${selectedAgent.name}"${selectedAgent.role ? ` [${selectedAgent.role}]` : ""} and starting task`,
      );
      startTask(assignedTask, selectedAgent);
      availableAgents.delete(selectedAgent.id);
      summary.assigned += 1;
      summary.started += 1;
    } catch (error) {
      summary.skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      writeDispatchLog(db, assignedTask, `failed to start with agent "${selectedAgent.name}": ${message}`);
    }
    } catch (iterationError) {
      // Defensive outer guard: any unexpected error from the iteration
      // body (sqlite race, missing agent row, workflow loader hiccup,
      // ...) must NOT bubble up to the setInterval callback, where it
      // would surface as `uncaughtException` and crash the whole
      // server. Log + skip + move on. `writeDispatchLog`'s own FK guard
      // means we can still emit a record against any task that still
      // exists; we wrap that call too because the same race can affect
      // it indirectly via the agents table.
      summary.skipped += 1;
      const message = iterationError instanceof Error ? iterationError.message : String(iterationError);
      console.warn(`[auto-dispatcher] iteration failed for task ${task.id}: ${message}`);
      try {
        writeDispatchLog(db, task, `iteration aborted: ${message}`);
      } catch {
        // Already best-effort; nothing else to do.
      }
    }
  }

  return summary;
}

export function startAutoDispatchScheduler(
  db: DatabaseSync,
  ws: WsHub,
): ReturnType<typeof setInterval> | null {
  if (AUTO_DISPATCH_INTERVAL_MS <= 0) {
    return null;
  }

  const run = () => {
    dispatchAutoStartableTasks(db, ws);
  };

  run();
  return setInterval(run, AUTO_DISPATCH_INTERVAL_MS);
}
