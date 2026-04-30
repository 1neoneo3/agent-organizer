import { randomUUID } from "node:crypto";
import { buildTaskSummaryUpdate } from "../ws/update-payloads.js";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { WsHub } from "../ws/hub.js";
import type { Task } from "../types/runtime.js";
import { spawnAgent } from "../spawner/process-manager.js";
import { autoDispatchTask } from "../tasks/auto-dispatch.js";
import {
  AUTO_ASSIGN_TASK_ON_CREATE,
  AUTO_RUN_TASK_ON_CREATE,
  GITHUB_SYNC_ENABLED,
  GITHUB_SYNC_INTERVAL_MS,
  GITHUB_SYNC_PROJECT_PATH,
  GITHUB_SYNC_REPO,
  GITHUB_SYNC_TOKEN,
} from "../config/runtime.js";
import { nextTaskNumber } from "../domain/task-number.js";

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  pull_request?: unknown;
  labels?: Array<{ name?: string } | string>;
}

function priorityFromLabels(issue: GitHubIssue): number {
  const labelNames = (issue.labels ?? [])
    .map((label) => typeof label === "string" ? label : label.name ?? "")
    .map((name) => name.toLowerCase());

  if (labelNames.some((name) => name.includes("priority:high") || name.includes("priority/high") || name === "high")) {
    return 8;
  }
  if (labelNames.some((name) => name.includes("priority:low") || name.includes("priority/low") || name === "low")) {
    return 2;
  }
  return 5;
}

function buildDescription(issue: GitHubIssue): string {
  const parts = [`GitHub Issue: ${issue.html_url}`];
  if (issue.body?.trim()) {
    parts.push("");
    parts.push(issue.body.trim());
  }
  return parts.join("\n");
}

export function resolveGitHubSyncToken(
  envToken: string,
  readGhToken: () => string = () => execFileSync("gh", ["auth", "token"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
): string {
  if (envToken.trim()) {
    return envToken;
  }

  try {
    return readGhToken().trim();
  } catch {
    return "";
  }
}

export function syncGithubIssues(
  db: DatabaseSync,
  ws: WsHub,
  issues: GitHubIssue[],
  options?: {
    projectPath?: string;
    autoAssign?: boolean;
    autoRun?: boolean;
    spawnAgent?: typeof spawnAgent;
  },
): { created: number; updated: number; cancelled: number } {
  const projectPath = options?.projectPath ?? GITHUB_SYNC_PROJECT_PATH;
  const autoAssign = options?.autoAssign ?? AUTO_ASSIGN_TASK_ON_CREATE;
  const autoRun = options?.autoRun ?? AUTO_RUN_TASK_ON_CREATE;
  const taskSpawner = options?.spawnAgent ?? spawnAgent;
  const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === "open");
  const seen = new Set(openIssues.map((issue) => String(issue.number)));
  let created = 0;
  let updated = 0;
  let cancelled = 0;

  for (const issue of openIssues) {
    const externalId = String(issue.number);
    const existing = db.prepare(
      "SELECT id FROM tasks WHERE external_source = 'github' AND external_id = ?"
    ).get(externalId) as { id: string } | undefined;

    const title = `[GH #${issue.number}] ${issue.title}`;
    const description = buildDescription(issue);
    const now = Date.now();

    if (existing) {
      db.prepare(
        "UPDATE tasks SET title = ?, description = ?, project_path = ?, updated_at = ? WHERE id = ?"
      ).run(title, description, projectPath, now, existing.id);
      const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(existing.id) as Task | undefined;
      if (task) ws.broadcast("task_update", buildTaskSummaryUpdate(task));
      updated++;
      continue;
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO tasks (
        id, title, description, assigned_agent_id, project_path, status, priority, task_size,
        task_number, depends_on, result, review_count, directive_id, pr_url, external_source,
        external_id, started_at, completed_at, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, 'inbox', ?, 'medium', ?, NULL, NULL, 0, NULL, NULL, 'github', ?, NULL, NULL, ?, ?)`
    ).run(id, title, description, projectPath, priorityFromLabels(issue), nextTaskNumber(db), externalId, now, now);

    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
    if (task) ws.broadcast("task_update", buildTaskSummaryUpdate(task));
    autoDispatchTask(db, ws, id, {
      autoAssign,
      autoRun,
      spawnAgent: taskSpawner,
    });
    created++;
  }

  const staleTasks = db.prepare(
    "SELECT id FROM tasks WHERE external_source = 'github' AND status = 'inbox'"
  ).all() as Array<{ id: string }>;
  for (const task of staleTasks) {
    const externalId = db.prepare("SELECT external_id FROM tasks WHERE id = ?").get(task.id) as { external_id: string | null } | undefined;
    if (!externalId?.external_id || seen.has(externalId.external_id)) continue;

    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?").run(now, now, task.id);
    db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)").run(task.id, "GitHub issue no longer open; task cancelled by sync");
    ws.broadcast("task_update", { id: task.id, status: "cancelled" });
    cancelled++;
  }

  return { created, updated, cancelled };
}

export async function fetchGitHubIssues(repo: string, token: string): Promise<GitHubIssue[]> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agent-organizer-github-sync",
  };
  if (token.trim()) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`GitHub sync failed: HTTP ${response.status}`);
  }

  return response.json() as Promise<GitHubIssue[]>;
}

export function startGithubIssueSync(
  db: DatabaseSync,
  ws: WsHub,
  fetcher: (repo: string, token: string) => Promise<GitHubIssue[]> = fetchGitHubIssues,
  options?: {
    resolveRepo?: () => string;
    resolveToken?: () => string;
    schedule?: typeof setInterval;
  },
): ReturnType<typeof setInterval> | null {
  if (!GITHUB_SYNC_ENABLED) {
    return null;
  }

  const resolveRepo = options?.resolveRepo ?? (() => GITHUB_SYNC_REPO);
  const resolveToken = options?.resolveToken ?? (() => resolveGitHubSyncToken(GITHUB_SYNC_TOKEN));
  const schedule = options?.schedule ?? setInterval;
  const repo = resolveRepo().trim();

  if (!repo) {
    console.warn("[github-sync] disabled: missing repo", { hasRepo: Boolean(repo) });
    return null;
  }

  let inFlight = false;
  const run = async () => {
    if (inFlight) {
      return;
    }

    inFlight = true;
    try {
      const token = resolveToken().trim();
      const issues = await fetcher(repo, token);
      syncGithubIssues(db, ws, issues, { projectPath: GITHUB_SYNC_PROJECT_PATH });
    } catch (error) {
      console.error("[github-sync]", error);
    } finally {
      inFlight = false;
    }
  };

  void run();
  return schedule(() => {
    void run();
  }, GITHUB_SYNC_INTERVAL_MS);
}
