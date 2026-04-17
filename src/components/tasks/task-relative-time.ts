const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

export function formatRelativeTaskTime(createdAt: number, now = Date.now()): string {
  const diff = Math.max(0, now - createdAt);

  if (diff < MINUTE_MS) {
    return "just now";
  }

  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)}m ago`;
  }

  if (diff < DAY_MS) {
    return `${Math.floor(diff / HOUR_MS)}h ago`;
  }

  if (diff < WEEK_MS) {
    return `${Math.floor(diff / DAY_MS)}d ago`;
  }

  if (diff < YEAR_MS) {
    const months = Math.max(1, Math.floor(diff / MONTH_MS));
    return `${months}mo ago`;
  }

  return `${Math.floor(diff / YEAR_MS)}y ago`;
}

export function formatTaskTimestamp(createdAt: number): string {
  return new Date(createdAt).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
