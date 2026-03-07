import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CacheService } from "../cache/cache-service.js";
import {
  GITHUB_SYNC_ENABLED,
  GITHUB_SYNC_INTERVAL_MS,
  GITHUB_SYNC_PROJECT_PATH,
  GITHUB_SYNC_REPO,
  GITHUB_SYNC_TOKEN,
} from "../config/runtime.js";
import type { WsHub } from "../ws/hub.js";

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

function nextTaskNumber(db: DatabaseSync): string {
  const row = db.prepare(
    "SELECT MAX(CAST(SUBSTR(task_number, 2) AS INTEGER)) AS max_num FROM tasks WHERE task_number LIKE '#%'"
  ).get() as { max_num: number | null } | undefined;
  return `#${(row?.max_num ?? 0) + 1}`;
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

function invalidateCaches(cache?: CacheService): void {
  if (!cache) return;
  void cache.invalidatePattern("tasks:*");
  void cache.del("agents:all");
}

export function syncGithubIssues(
  db: DatabaseSync,
  ws: WsHub,
  issues: GitHubIssue[],
  options?: { projectPath?: string; cache?: CacheService },
): { created: number; updated: number; cancelled: number } {
  const projectPath = options?.projectPath ?? GITHUB_SYNC_PROJECT_PATH;
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
      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(existing.id);
      ws.broadcast("task_update", updatedTask);
      updated += 1;
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

    const createdTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    ws.broadcast("task_update", createdTask);
    created += 1;
  }

  const staleTasks = db.prepare(
    "SELECT id, external_id FROM tasks WHERE external_source = 'github' AND status = 'inbox'"
  ).all() as Array<{ id: string; external_id: string | null }>;

  for (const task of staleTasks) {
    if (!task.external_id || seen.has(task.external_id)) {
      continue;
    }

    const now = Date.now();
    db.prepare("UPDATE tasks SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, task.id);
    db.prepare("INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)")
      .run(task.id, "GitHub issue no longer open; task cancelled by sync");
    ws.broadcast("task_update", { id: task.id, status: "cancelled", completed_at: now, updated_at: now });
    cancelled += 1;
  }

  invalidateCaches(options?.cache);
  return { created, updated, cancelled };
}

export async function fetchGitHubIssues(repo: string, token: string): Promise<GitHubIssue[]> {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "agent-organizer-github-sync",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub sync failed: HTTP ${response.status}`);
  }

  return response.json() as Promise<GitHubIssue[]>;
}

export function startGithubIssueSync(
  db: DatabaseSync,
  ws: WsHub,
  cache?: CacheService,
  fetcher: (repo: string, token: string) => Promise<GitHubIssue[]> = fetchGitHubIssues,
): ReturnType<typeof setInterval> | null {
  if (!GITHUB_SYNC_ENABLED) {
    return null;
  }

  if (!GITHUB_SYNC_REPO || !GITHUB_SYNC_TOKEN) {
    console.warn("[github-sync] disabled: missing repo or token", {
      hasRepo: Boolean(GITHUB_SYNC_REPO),
      hasToken: Boolean(GITHUB_SYNC_TOKEN),
    });
    return null;
  }

  const run = async () => {
    try {
      const issues = await fetcher(GITHUB_SYNC_REPO, GITHUB_SYNC_TOKEN);
      syncGithubIssues(db, ws, issues, { projectPath: GITHUB_SYNC_PROJECT_PATH, cache });
    } catch (error) {
      console.error("[github-sync]", error);
    }
  };

  void run();
  return setInterval(() => {
    void run();
  }, GITHUB_SYNC_INTERVAL_MS);
}
