import type { DatabaseSync } from "node:sqlite";

export type HumanReviewAutoMarker =
  | "STARTED"
  | "CLEARED"
  | "AWAITING_HUMAN"
  | "EXHAUSTED";

const MARKER_PREFIX = "[HUMAN_REVIEW_AUTO:";

export function formatHumanReviewAutoMarker(marker: HumanReviewAutoMarker): string {
  return `${MARKER_PREFIX}${marker}]`;
}

export function recordHumanReviewAutoMarker(
  db: DatabaseSync,
  taskId: string,
  marker: HumanReviewAutoMarker,
  detail?: string,
): void {
  const suffix = detail ? ` ${detail}` : "";
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage) VALUES (?, 'system', ?, 'human_review')",
  ).run(taskId, `${formatHumanReviewAutoMarker(marker)}${suffix}`);
}

export function getLatestHumanReviewAutoMarker(
  db: DatabaseSync,
  taskId: string,
): HumanReviewAutoMarker | null {
  const row = db
    .prepare(
      "SELECT message FROM task_logs WHERE task_id = ? AND kind = 'system' AND message LIKE '[HUMAN_REVIEW_AUTO:%' ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(taskId) as { message: string } | undefined;
  const match = row?.message.match(/^\[HUMAN_REVIEW_AUTO:(STARTED|CLEARED|AWAITING_HUMAN|EXHAUSTED)\]/);
  return (match?.[1] as HumanReviewAutoMarker | undefined) ?? null;
}

