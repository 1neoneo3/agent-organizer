import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Task } from "../types/runtime.js";

/**
 * Build the full prompt to send to a CLI agent, including task info and skill injections.
 */
export function buildTaskPrompt(task: Task, opts?: { selfReview?: boolean }): string {
  const parts: string[] = [];

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
