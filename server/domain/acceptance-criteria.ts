/**
 * Toggle a GitHub-Flavored-Markdown task list item inside a refinement plan.
 *
 * The UI surfaces acceptance-criteria checkboxes rendered from markdown
 * `- [ ]` / `- [x]` items in `refinement_plan`. During `pr_review` the
 * reviewer can click these boxes to mark each criterion as verified. Because
 * refinement plans are stored as plain text, we patch the plan source by
 * finding the N-th task list marker and flipping its state. This keeps the
 * "checked" signal visible everywhere the plan is rendered (detail modal,
 * terminal logs, audit trail) without a schema change.
 *
 * Matching rules:
 *   - Accepts `-`, `*`, or `+` list markers per GFM.
 *   - Tolerates leading whitespace (nested lists).
 *   - Preserves the original indentation and marker character.
 *   - Only the marker itself (`[ ]` / `[x]`) is rewritten; the rest of
 *     the line and the whole plan text are untouched, so round-tripping
 *     a toggle back to unchecked yields a byte-identical plan.
 */

const CHECKBOX_PATTERN = /^(\s*[-*+]\s+)\[([ xX])\](.*)$/;

export interface ToggleResult {
  /** The patched plan text, or `null` if `index` is out of range. */
  text: string | null;
  /** Number of task list items found in the plan. Handy for diagnostics. */
  total: number;
}

/**
 * Toggle the `index`-th (0-based) task list item in `plan` to `checked`.
 *
 * Returns `text: null` when `index` is out of range so callers can
 * respond with HTTP 400 instead of silently patching the wrong line.
 */
export function setAcceptanceCriterionChecked(
  plan: string,
  index: number,
  checked: boolean,
): ToggleResult {
  const lines = plan.split("\n");
  let seen = 0;
  let patched = false;

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(CHECKBOX_PATTERN);
    if (!match) continue;
    if (seen === index) {
      const [, prefix, , rest] = match;
      lines[i] = `${prefix}[${checked ? "x" : " "}]${rest}`;
      patched = true;
    }
    seen += 1;
  }

  return { text: patched ? lines.join("\n") : null, total: seen };
}

/** Count acceptance-criteria checkboxes in a plan. */
export function countAcceptanceCriteria(plan: string): number {
  let total = 0;
  for (const line of plan.split("\n")) {
    if (CHECKBOX_PATTERN.test(line)) total += 1;
  }
  return total;
}
