import type { DatabaseSync } from "node:sqlite";

export type HumanReviewAutoMarker =
  | "STARTED"
  | "CLEARED"
  | "AWAITING_HUMAN"
  | "EXHAUSTED";

export type HumanReviewAutoStatus =
  | "started"
  | "cleared"
  | "awaiting_human"
  | "exhausted";

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

function parseHumanReviewAutoMarker(message: string | null | undefined): HumanReviewAutoMarker | null {
  const match = message?.match(/^\[HUMAN_REVIEW_AUTO:(STARTED|CLEARED|AWAITING_HUMAN|EXHAUSTED)\]/);
  return (match?.[1] as HumanReviewAutoMarker | undefined) ?? null;
}

export function markerToHumanReviewAutoStatus(
  marker: HumanReviewAutoMarker | null,
): HumanReviewAutoStatus | null {
  if (!marker) return null;
  return marker.toLowerCase() as HumanReviewAutoStatus;
}

export function getLatestHumanReviewAutoStatus(
  db: DatabaseSync,
  taskId: string,
): HumanReviewAutoStatus | null {
  return markerToHumanReviewAutoStatus(getLatestHumanReviewAutoMarker(db, taskId));
}

export function getLatestHumanReviewAutoStatuses(
  db: DatabaseSync,
  taskIds: readonly string[],
): Map<string, HumanReviewAutoStatus | null> {
  const uniqueTaskIds = Array.from(new Set(taskIds.filter((id) => id.length > 0)));
  if (uniqueTaskIds.length === 0) return new Map();

  const placeholders = uniqueTaskIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT task_id, message
       FROM task_logs
       WHERE task_id IN (${placeholders})
         AND kind = 'system'
         AND message LIKE '[HUMAN_REVIEW_AUTO:%'
       ORDER BY task_id, created_at DESC, id DESC`,
    )
    .all(...uniqueTaskIds) as Array<{ task_id: string; message: string }>;

  const statuses = new Map<string, HumanReviewAutoStatus | null>();
  for (const row of rows) {
    if (statuses.has(row.task_id)) continue;
    statuses.set(row.task_id, markerToHumanReviewAutoStatus(parseHumanReviewAutoMarker(row.message)));
  }
  return statuses;
}
