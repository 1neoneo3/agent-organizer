export interface CsvColumn {
  key: string;
  header: string;
  format?: (value: unknown) => string;
}

function formatTimestamp(value: unknown): string {
  if (value == null) return "";
  return new Date(value as number).toISOString();
}

export const CSV_COLUMNS: readonly CsvColumn[] = [
  { key: "id", header: "ID" },
  { key: "task_number", header: "Task Number" },
  { key: "title", header: "Title" },
  { key: "description", header: "Description" },
  { key: "status", header: "Status" },
  { key: "priority", header: "Priority" },
  { key: "task_size", header: "Size" },
  { key: "assigned_agent_id", header: "Agent ID" },
  { key: "project_path", header: "Project Path" },
  { key: "result", header: "Result" },
  { key: "pr_url", header: "PR URL" },
  { key: "review_count", header: "Review Count" },
  { key: "depends_on", header: "Depends On" },
  { key: "started_at", header: "Started At", format: formatTimestamp },
  { key: "completed_at", header: "Completed At", format: formatTimestamp },
  { key: "created_at", header: "Created At", format: formatTimestamp },
  { key: "updated_at", header: "Updated At", format: formatTimestamp },
] as const;

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function tasksToCsv(tasks: Record<string, unknown>[]): string {
  const header = CSV_COLUMNS.map((c) => c.header).join(",");
  const rows = tasks.map((task) =>
    CSV_COLUMNS.map((col) => {
      const raw = task[col.key];
      if (raw == null) return "";
      const str = col.format ? col.format(raw) : String(raw);
      return escapeCsvField(str);
    }).join(","),
  );
  return `\uFEFF${header}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}
