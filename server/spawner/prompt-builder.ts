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
 * Build a prompt that instructs the AI to decompose a directive into concrete tasks.
 * The AI must respond with a JSON array.
 */
export function buildDecomposePrompt(directive: Directive): string {
  const parts: string[] = [];

  parts.push("## Language");
  parts.push("Always respond and communicate in Japanese (日本語). Code comments, variable names, and commit messages should remain in English.");
  parts.push("");
  parts.push("You are a project manager AI. Your job is to decompose the following directive into concrete, actionable tasks.");
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
  parts.push("- Ordered by dependency (earlier tasks first)");
  parts.push("");
  parts.push("Respond with ONLY a JSON array (no markdown fences, no extra text). Each element:");
  parts.push('```');
  parts.push(JSON.stringify({
    title: "Task title",
    description: "Detailed description of what to do",
    task_size: "small | medium | large",
    priority: "0-10 (higher = more important)",
  }, null, 2));
  parts.push('```');
  parts.push("");
  parts.push("Output the JSON array now:");

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
