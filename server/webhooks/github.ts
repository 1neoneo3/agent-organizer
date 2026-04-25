import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { tryCleanupCompletedTaskWorkspace } from "../workflow/workspace-manager.js";
import type { Task } from "../types/runtime.js";

/**
 * GitHub webhook handling.
 *
 * The only event we act on is `pull_request.closed` with `merged: true`.
 * When a PR tracked by a task is merged, the task transitions to `done`
 * and the auto-dispatcher picks up any dependents that were waiting.
 *
 * Multi-PR tasks (tasks with a non-empty `pr_urls` JSON array) accumulate
 * merged URLs in `merged_pr_urls` — the task only flips to done when
 * every URL in `pr_urls` is also present in `merged_pr_urls`. Single-PR
 * tasks (only `pr_url` set) transition immediately.
 */

export interface PullRequestWebhookPayload {
  action?: string;
  pull_request?: {
    html_url?: string;
    url?: string;
    merged?: boolean;
    merge_commit_sha?: string | null;
    number?: number;
    title?: string;
  };
  repository?: { full_name?: string };
}

export interface MergeMatchResult {
  task_id: string;
  task_number: string | null;
  before_status: string;
  after_status: "done" | string; // "done" if fully merged, otherwise unchanged
  merged_pr_urls: string[]; // cumulative list after this event
  all_merged: boolean;
}

export interface HandleMergedPrResult {
  matched: MergeMatchResult[];
  completed_task_ids: string[];
}

/**
 * Verify `X-Hub-Signature-256` against the raw request body using the
 * configured webhook secret. When `secret` is empty, verification is
 * skipped (local dev). A missing or malformed header is rejected.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: Buffer | string,
  header: string | undefined,
): boolean {
  if (!secret) return true; // dev mode — no secret configured
  if (!header || !header.startsWith("sha256=")) return false;
  const bodyBuf = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = "sha256=" + createHmac("sha256", secret).update(bodyBuf).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Event filter. Only `pull_request.closed` with merged=true is actionable.
 * Returns `true` when the caller should proceed to task-matching.
 */
export function isPullRequestMergedEvent(
  event: string | undefined,
  payload: PullRequestWebhookPayload,
): boolean {
  return (
    event === "pull_request" &&
    payload.action === "closed" &&
    payload.pull_request?.merged === true &&
    typeof payload.pull_request.html_url === "string" &&
    payload.pull_request.html_url.length > 0
  );
}

interface TaskRow {
  id: string;
  task_number: string | null;
  status: string;
  pr_url: string | null;
  pr_urls: string | null;
  merged_pr_urls: string | null;
  result: string | null;
  // Fields required for tryCleanupCompletedTaskWorkspace on done.
  // `title` feeds branch-name reconstruction; `project_path` resolves
  // the repo root.
  title: string;
  project_path: string | null;
}

/**
 * Parse a JSON string column into a string[] (tolerant of null / bad
 * JSON — falls back to empty array). Used for `pr_urls` and
 * `merged_pr_urls`.
 */
function parseUrlList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Find every non-terminal task whose `pr_url` or `pr_urls` references
 * the given PR URL. Uses a coarse `LIKE` predicate to hit the sqlite
 * index-free case, then filters in JS to guarantee exact-URL match.
 */
export function findTasksByPrUrl(db: DatabaseSync, prUrl: string): TaskRow[] {
  const like = `%${prUrl}%`;
  const rows = db
    .prepare(
      `SELECT id, task_number, status, pr_url, pr_urls, merged_pr_urls, result, title, project_path
       FROM tasks
       WHERE status NOT IN ('done', 'cancelled')
         AND (pr_url = ? OR pr_urls LIKE ?)`,
    )
    .all(prUrl, like) as unknown as TaskRow[];
  return rows.filter((r) => {
    if (r.pr_url === prUrl) return true;
    return parseUrlList(r.pr_urls).includes(prUrl);
  });
}

/**
 * Record a merged PR URL against a task and, if the task's full PR set
 * is now merged, transition to `done`. Returns the observed
 * before/after state so callers can surface it in the response.
 *
 * - Single-PR tasks (no `pr_urls`, only `pr_url`): complete immediately.
 * - Multi-PR tasks: accumulate the URL in `merged_pr_urls`; complete
 *   when every `pr_urls` entry is also in `merged_pr_urls`.
 */
export function recordMergeAndMaybeComplete(
  db: DatabaseSync,
  task: TaskRow,
  prUrl: string,
  mergeCommitSha: string | null,
  now: number = Date.now(),
): MergeMatchResult {
  const mergedAlready = parseUrlList(task.merged_pr_urls);
  const mergedSet = new Set(mergedAlready);
  mergedSet.add(prUrl);
  const mergedList = Array.from(mergedSet);

  const prUrlsList = parseUrlList(task.pr_urls);
  // If `pr_urls` is empty but single `pr_url` matches, treat it as a
  // single-PR task — `all_merged` is defined by that single URL.
  const expected = prUrlsList.length > 0 ? prUrlsList : task.pr_url ? [task.pr_url] : [prUrl];
  const allMerged = expected.every((u) => mergedSet.has(u));

  const resultLine = `Merged: ${prUrl}${mergeCommitSha ? ` (${mergeCommitSha})` : ""}`;
  if (allMerged) {
    const nextResult = task.result ? `${task.result}\n${resultLine}` : resultLine;
    db.prepare(
      `UPDATE tasks
       SET status = 'done',
           merged_pr_urls = ?,
           result = ?,
           completed_at = ?,
           updated_at = ?
       WHERE id = ? AND status NOT IN ('done', 'cancelled')`,
    ).run(JSON.stringify(mergedList), nextResult, now, now, task.id);

    // Best-effort: prune the per-task worktree once all PRs are merged.
    // The branch deletion step uses safe `-d`, so unpushed work-in-progress
    // is preserved.
    try { tryCleanupCompletedTaskWorkspace(task as Task); } catch { /* non-fatal */ }

    return {
      task_id: task.id,
      task_number: task.task_number,
      before_status: task.status,
      after_status: "done",
      merged_pr_urls: mergedList,
      all_merged: true,
    };
  }

  // Partial: accumulate the URL but leave status alone.
  db.prepare(
    `UPDATE tasks
     SET merged_pr_urls = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(JSON.stringify(mergedList), now, task.id);
  return {
    task_id: task.id,
    task_number: task.task_number,
    before_status: task.status,
    after_status: task.status,
    merged_pr_urls: mergedList,
    all_merged: false,
  };
}

/**
 * Top-level handler for a `pull_request.closed + merged:true` event.
 * Resolves affected tasks, applies merge bookkeeping, writes a log
 * line per task, and invokes `onCompleted` once if any task actually
 * transitioned to done — callers hook `dispatchAutoStartableTasks` and
 * `ws.broadcast` in there to avoid tight coupling to the express layer.
 */
export function handleMergedPrEvent(
  db: DatabaseSync,
  payload: PullRequestWebhookPayload,
  hooks: {
    log?: (taskId: string, message: string) => void;
    broadcastTaskUpdate?: (taskId: string) => void;
    onCompletion?: () => void;
  } = {},
  now: number = Date.now(),
): HandleMergedPrResult {
  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) {
    return { matched: [], completed_task_ids: [] };
  }
  const tasks = findTasksByPrUrl(db, prUrl);
  const matched: MergeMatchResult[] = [];
  const completed: string[] = [];
  const sha = payload.pull_request?.merge_commit_sha ?? null;

  for (const task of tasks) {
    const result = recordMergeAndMaybeComplete(db, task, prUrl, sha, now);
    matched.push(result);

    if (result.all_merged) {
      completed.push(result.task_id);
      hooks.log?.(
        result.task_id,
        `[PR Merge] ${prUrl} merged${sha ? ` (${sha})` : ""} → task → done`,
      );
    } else {
      const remaining = parseUrlList(task.pr_urls).filter(
        (u) => !result.merged_pr_urls.includes(u),
      );
      hooks.log?.(
        result.task_id,
        `[PR Merge] ${prUrl} merged; waiting on ${remaining.length} more PR${remaining.length === 1 ? "" : "s"}`,
      );
    }
    hooks.broadcastTaskUpdate?.(result.task_id);
  }

  if (completed.length > 0) {
    hooks.onCompletion?.();
  }

  return { matched, completed_task_ids: completed };
}
