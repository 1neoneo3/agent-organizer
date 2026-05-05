/**
 * Extract the list of files a task intends to modify from its
 * refinement_plan text.
 *
 * The refinement prompt (server/spawner/prompt-builder.ts) asks the
 * agent to enumerate target files under a `## Files to Modify` (EN) or
 * `## 修正するファイル` / `## planned_files` (JA / canonical alias)
 * heading, usually one per bullet with the path wrapped in backticks:
 *
 *     ## Files to Modify
 *
 *     - `src/auth.ts` — summary of the change
 *     - `src/new-file.ts` — (new file) purpose
 *
 * This helper is the **static** side of the file-conflict detector
 * added in follow-up to issue #99. The dynamic side (actually-touched
 * files inferred from tool_call logs during a live run) is intentionally
 * deferred to a later iteration — the static list is sufficient to stop
 * the most common case: two tasks whose refinement plans both list the
 * same file running in parallel.
 */

export const PLANNED_FILES_HEADINGS = [
  "Files to Modify",
  "Files To Modify",
  "変更対象ファイル",
  "修正するファイル",
  "変更するファイル",
  "編集するファイル",
  "planned_files",
  "planned files",
] as const;

/**
 * Normalize a file path so overlapping-path detection is robust against
 * harmless formatting differences between two refinement plans.
 *
 *  - Strip surrounding whitespace.
 *  - Strip leading `./` so `./src/a.ts` and `src/a.ts` collide.
 *  - Collapse duplicate slashes (`src//a.ts` → `src/a.ts`).
 *  - Strip trailing slash on directories so `src/auth/` and
 *    `src/auth` collide.
 *
 * Intentionally does NOT resolve `..` or convert to an absolute path:
 * refinement plans are repo-relative by convention, and pulling in
 * `node:path.resolve` would require knowing the project root in every
 * caller.
 */
export function normalizePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return trimmed;
  let p = trimmed;
  if (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Regex for a bullet line that carries a backtick-wrapped file path.
 * Deliberately tolerant: matches `-`, `*`, or `•` bullets and any
 * whitespace leading; the path is the first backtick span on the line.
 */
const BULLET_PATH_RE = /^\s*[-*•]\s*`([^`\n]+)`/;

/**
 * Regex for a Markdown table row whose first cell is a backtick-wrapped
 * file path. Refinement plans commonly render "変更対象ファイル" as a
 * two-column table (`ファイル | 変更内容`), so only the first cell is
 * considered a path source.
 */
const TABLE_FIRST_CELL_PATH_RE = /^\s*\|\s*`([^`\n|]+)`\s*\|/;
const JSON_CODE_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/gi;

/**
 * Regex that matches any of the recognized "files to modify" headings.
 * `##` level is expected but the helper tolerates `###` as well.
 *
 * Trailing tolerance is deliberately narrow: only whitespace, or a single
 * parenthesized annotation (e.g. `(planned)`, `(Files to Modify)`) is
 * allowed after the heading word. Plain trailing tokens are rejected so
 * `## Files to Modify Backup` and `## Files to Modify Or Skip` do NOT
 * match — they are not the planned-files section and picking them up
 * would silently feed wrong paths into the file-conflict gate.
 */
function buildHeadingRegex(): RegExp {
  const alt = PLANNED_FILES_HEADINGS.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^#{2,3}\\s*(?:${alt})\\s*(?:\\([^()\\n]+\\)\\s*)?$`, "im");
}

const HEADING_RE = buildHeadingRegex();
const NEXT_HEADING_RE = /^#{1,3}\s+/m;

function normalizePathList(entries: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const norm = normalizePath(entry);
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

function parsePathJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizePathList(parsed);
  } catch {
    return [];
  }
}

function extractJsonArrayPaths(sectionBody: string): string[] {
  const trimmed = sectionBody.trim();
  if (trimmed.length === 0) return [];

  for (const match of trimmed.matchAll(JSON_CODE_BLOCK_RE)) {
    const parsed = parsePathJsonArray(match[1]?.trim() ?? "");
    if (parsed.length > 0) return parsed;
  }

  const direct = parsePathJsonArray(trimmed);
  if (direct.length > 0) return direct;

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart === -1 || arrayEnd <= arrayStart) return [];
  return parsePathJsonArray(trimmed.slice(arrayStart, arrayEnd + 1));
}

/**
 * Extract the list of files named under the "Files to Modify" section
 * of a refinement plan. Returns an empty array for plans that do not
 * include the heading (e.g. a plan that only produces prose, or a
 * task that never went through refinement).
 *
 * Paths are returned normalized and de-duplicated, preserving first-
 * occurrence order so the output is deterministic for a given input.
 */
export function extractPlannedFilesFromPlan(plan: string | null | undefined): string[] {
  if (!plan) return [];

  const headingMatch = HEADING_RE.exec(plan);
  if (!headingMatch) return [];

  // Slice from right after the heading line to the next same-or-higher
  // heading (or end-of-plan). `NEXT_HEADING_RE.exec` is run on the
  // sliced tail so its `.index` is relative to that tail.
  const headingEnd = headingMatch.index + headingMatch[0].length;
  const tail = plan.slice(headingEnd);
  const nextHeading = NEXT_HEADING_RE.exec(tail);
  const sectionBody = nextHeading ? tail.slice(0, nextHeading.index) : tail;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of sectionBody.split("\n")) {
    const m = BULLET_PATH_RE.exec(line) ?? TABLE_FIRST_CELL_PATH_RE.exec(line);
    if (!m) continue;
    const norm = normalizePath(m[1]);
    if (norm.length === 0) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  if (out.length > 0) return out;
  return extractJsonArrayPaths(sectionBody);
}

/**
 * Parse `tasks.planned_files` (JSON array of normalized paths) back
 * into an array. Silently yields `[]` for null/malformed payloads —
 * callers treat an empty list as "no static overlap information
 * available" and skip the file-conflict check for that task.
 *
 * Defensive `normalizePath` pass: the happy path (extraction →
 * persistence → read) already normalizes before storing, but any
 * future write path (admin API, bulk import, manual UPDATE via SQL
 * console, migration backfill) could insert raw strings. Running
 * normalizePath at read time makes `intersectFilePaths` — which
 * compares with strict Set equality — robust against those skew
 * cases at zero material cost.
 */
export function parsePlannedFiles(raw: string | null): string[] {
  if (!raw) return [];
  return parsePathJsonArray(raw);
}

/**
 * Compute the set intersection of two path lists, returning a sorted
 * deduplicated array. Comparison uses the canonical (already-
 * normalized) form, so callers must normalize inputs beforehand — the
 * constructor pipeline (extractPlannedFilesFromPlan) does this, and
 * so does parsePlannedFiles when reading rows that were persisted via
 * the same pipeline.
 */
export function intersectFilePaths(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const setB = new Set(b);
  const overlap = new Set<string>();
  for (const path of a) {
    if (setB.has(path)) overlap.add(path);
  }
  return Array.from(overlap).sort();
}
