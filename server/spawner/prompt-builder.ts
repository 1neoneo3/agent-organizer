import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Task, Directive } from "../types/runtime.js";

// ---------------------------------------------------------------------------
// Shared context loaders
// ---------------------------------------------------------------------------

interface RuleSnippet {
  name: string;
  content: string;
}

/** Load all `~/.claude/rules/*.md` files. */
function loadRules(): RuleSnippet[] {
  const rulesDir = join(homedir(), ".claude", "rules");
  try {
    const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
    return files.map((f) => ({
      name: f.replace(/\.md$/, ""),
      content: readFileSync(join(rulesDir, f), "utf-8"),
    }));
  } catch {
    return [];
  }
}

/** Load `CLAUDE.md` from the project root if it exists. */
function loadProjectInstructions(projectPath: string | null): string | null {
  if (!projectPath) return null;
  const claudeMdPath = join(projectPath, "CLAUDE.md");
  try {
    if (existsSync(claudeMdPath)) {
      return readFileSync(claudeMdPath, "utf-8");
    }
  } catch {
    /* ignore */
  }
  return null;
}

interface SkillSnippet {
  name: string;
  content: string;
}

/**
 * Load skill snippets from:
 *   1. ~/.claude/skills/<dir>/SKILL.md  (standard skills)
 *   2. ~/.claude/skills/learned/*.md    (learned skills)
 *
 * Budget: max 2000 chars per skill, max 50 KB total.
 */
function loadSkillSnippets(): SkillSnippet[] {
  const skillsDir = join(homedir(), ".claude", "skills");
  const snippets: SkillSnippet[] = [];

  try {
    // 1. ~/.claude/skills/*/SKILL.md
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "learned") {
        const skillMd = join(skillsDir, entry.name, "SKILL.md");
        if (existsSync(skillMd)) {
          snippets.push({
            name: entry.name,
            content: readFileSync(skillMd, "utf-8"),
          });
        }
      }
    }

    // 2. ~/.claude/skills/learned/*.md
    const learnedDir = join(skillsDir, "learned");
    try {
      const learnedFiles = readdirSync(learnedDir).filter((f) =>
        f.endsWith(".md"),
      );
      for (const f of learnedFiles) {
        snippets.push({
          name: `learned/${f.replace(/\.md$/, "")}`,
          content: readFileSync(join(learnedDir, f), "utf-8"),
        });
      }
    } catch {
      /* learned dir may not exist */
    }
  } catch {
    return [];
  }

  // Budget control
  const MAX_PER_SKILL = 2000;
  const MAX_TOTAL = 50_000;
  let total = 0;
  const result: SkillSnippet[] = [];

  for (const s of snippets) {
    const truncated = s.content.slice(0, MAX_PER_SKILL);
    if (total + truncated.length > MAX_TOTAL) break;
    total += truncated.length;
    result.push({ name: s.name, content: truncated });
  }

  return result;
}

/** Append rules and CLAUDE.md sections to a prompt parts array. */
function appendSharedContext(
  parts: string[],
  projectPath: string | null,
): void {
  // Project instructions (CLAUDE.md)
  const projectInstructions = loadProjectInstructions(projectPath);
  if (projectInstructions) {
    parts.push("## Project Instructions (CLAUDE.md)");
    parts.push("");
    parts.push(projectInstructions);
    parts.push("");
  }

  // User rules
  const rules = loadRules();
  if (rules.length > 0) {
    parts.push("## Rules");
    parts.push("");
    for (const rule of rules) {
      parts.push(`### ${rule.name}`);
      parts.push(rule.content);
      parts.push("");
    }
  }
}

// ---------------------------------------------------------------------------
// Public prompt builders
// ---------------------------------------------------------------------------

/**
 * Build the full prompt to send to a CLI agent, including task info and skill injections.
 */
export function buildTaskPrompt(
  task: Task,
  opts?: { selfReview?: boolean },
): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  // Inject CLAUDE.md + rules
  appendSharedContext(parts, task.project_path);

  parts.push(`# Task: ${task.title}`);
  parts.push("");
  if (task.description) {
    parts.push(task.description);
    parts.push("");
  }
  if (task.project_path) {
    parts.push(`Project path: ${task.project_path}`);
    parts.push("");
  }

  // Self-review instruction
  if (opts?.selfReview) {
    parts.push("## Review Instructions");
    parts.push(
      "After completing the task, perform a self-review of your changes:",
    );
    parts.push("1. Verify the implementation meets the task requirements");
    parts.push("2. Check for obvious bugs, security issues, or regressions");
    parts.push("3. Confirm tests pass (if applicable)");
    parts.push(
      '4. Output a final line: `[SELF_REVIEW:PASS]` or `[SELF_REVIEW:FAIL:<reason>]`',
    );
    parts.push("");
  }

  // Inject relevant skills
  const skills = loadSkillSnippets();
  if (skills.length > 0) {
    parts.push("## Available Skills");
    parts.push("");
    for (const skill of skills) {
      parts.push(`### ${skill.name}`);
      parts.push(skill.content);
      parts.push("");
    }
  }

  // CEO Feedback file reference
  const feedbackPath = join("data", "feedback", `${task.id}.md`);
  if (existsSync(feedbackPath)) {
    parts.push("## CEO Feedback");
    parts.push("");
    parts.push(
      `There is active CEO feedback for this task. Read the file at: ${feedbackPath}`,
    );
    parts.push(
      "Check this file periodically for new directives and adjust your work accordingly.",
    );
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * Build a prompt that instructs the AI to decompose a directive into numbered tasks
 * with dependency tracking, plus a Markdown implementation plan.
 */
export function buildDecomposePrompt(directive: Directive): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push(
    "Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.",
  );
  parts.push("");

  // Inject CLAUDE.md + rules so decomposer understands project context
  appendSharedContext(parts, directive.project_path);

  parts.push(
    "You are a project manager AI. Your job is to decompose the following directive into concrete, actionable tasks with numbered IDs and dependency tracking.",
  );
  parts.push("");
  parts.push(`# Directive: ${directive.title}`);
  parts.push("");
  parts.push(directive.content);
  parts.push("");
  if (directive.project_path) {
    parts.push(`Project path: ${directive.project_path}`);
    parts.push("");
  }
  parts.push("## Instructions");
  parts.push("");
  parts.push(
    "Break this directive into 2-8 concrete tasks. Each task should be:",
  );
  parts.push("- Specific and actionable (a single agent can complete it)");
  parts.push("- Small to medium in scope");
  parts.push("- Numbered sequentially (T01, T02, T03...)");
  parts.push(
    "- Include dependency information (which tasks must complete before this one)",
  );
  parts.push("");
  parts.push(
    "Respond with TWO sections separated by the exact line `---PLAN---`:",
  );
  parts.push("");
  parts.push(
    "**SECTION 1**: JSON array of tasks (no markdown fences, no extra text before or after the JSON):",
  );
  parts.push("```");
  parts.push(
    JSON.stringify(
      [
        {
          task_id: "T01",
          title: "Set up database schema",
          description: "Detailed description of what to do",
          task_size: "small",
          priority: 10,
          depends_on: [],
        },
        {
          task_id: "T02",
          title: "Implement API endpoints",
          description: "Detailed description",
          task_size: "medium",
          priority: 8,
          depends_on: ["T01"],
        },
      ],
      null,
      2,
    ),
  );
  parts.push("```");
  parts.push("");
  parts.push("---PLAN---");
  parts.push("");
  parts.push("**SECTION 2**: Implementation plan in Markdown:");
  parts.push("```");
  parts.push("# Implementation Plan: {directive title}");
  parts.push("## Overview");
  parts.push("Brief summary of the implementation approach.");
  parts.push("## Task Dependency Graph");
  parts.push(
    "Show which tasks depend on which (e.g. T01 → T02 → T03).",
  );
  parts.push("## Implementation Order");
  parts.push("Recommended execution order with rationale.");
  parts.push("## Risk Analysis");
  parts.push("Potential risks and mitigations.");
  parts.push("## Prerequisites");
  parts.push("What needs to be in place before starting.");
  parts.push("## Estimated Effort");
  parts.push("Rough estimates per task.");
  parts.push("```");
  parts.push("");
  parts.push(
    "Output SECTION 1 (JSON) followed by ---PLAN--- followed by SECTION 2 (Markdown) now:",
  );

  return parts.join("\n");
}
