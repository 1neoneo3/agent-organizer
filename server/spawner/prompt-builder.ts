import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Task, Directive } from "../types/runtime.js";

/**
 * Build the full prompt to send to a CLI agent, including task info and skill injections.
 */
export function buildTaskPrompt(task: Task, opts?: { selfReview?: boolean }): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push("Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.");
  parts.push("");
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
      "After completing the task, perform a self-review of your changes:"
    );
    parts.push("1. Verify the implementation meets the task requirements");
    parts.push("2. Check for obvious bugs, security issues, or regressions");
    parts.push("3. Confirm tests pass (if applicable)");
    parts.push(
      '4. Output a final line: `[SELF_REVIEW:PASS]` or `[SELF_REVIEW:FAIL:<reason>]`'
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
      parts.push(skill.content.slice(0, 500)); // truncate for prompt budget
      parts.push("");
    }
  }

  // CEO Feedback file reference
  const feedbackPath = join("data", "feedback", `${task.id}.md`);
  if (existsSync(feedbackPath)) {
    parts.push("## CEO Feedback");
    parts.push("");
    parts.push(`There is active CEO feedback for this task. Read the file at: ${feedbackPath}`);
    parts.push("Check this file periodically for new directives and adjust your work accordingly.");
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
  parts.push("Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.");
  parts.push("");
  parts.push("You are a project manager AI. Your job is to decompose the following directive into concrete, actionable tasks with numbered IDs and dependency tracking.");
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
  parts.push("Break this directive into 2-8 concrete tasks. Each task should be:");
  parts.push("- Specific and actionable (a single agent can complete it)");
  parts.push("- Small to medium in scope");
  parts.push("- Numbered sequentially (T01, T02, T03...)");
  parts.push("- Include dependency information (which tasks must complete before this one)");
  parts.push("");
  parts.push("Respond with TWO sections separated by the exact line `---PLAN---`:");
  parts.push("");
  parts.push("**SECTION 1**: JSON array of tasks (no markdown fences, no extra text before or after the JSON):");
  parts.push("```");
  parts.push(JSON.stringify([
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
  ], null, 2));
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
  parts.push("Show which tasks depend on which (e.g. T01 → T02 → T03).");
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
  parts.push("Output SECTION 1 (JSON) followed by ---PLAN--- followed by SECTION 2 (Markdown) now:");

  return parts.join("\n");
}

interface SkillSnippet {
  name: string;
  content: string;
}

function loadSkillSnippets(): SkillSnippet[] {
  const skillsDir = join(homedir(), ".claude", "skills");
  try {
    const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
    return files.slice(0, 5).map((f) => ({
      name: f.replace(/\.md$/, ""),
      content: readFileSync(join(skillsDir, f), "utf-8"),
    }));
  } catch {
    return [];
  }
}
