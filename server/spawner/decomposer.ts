import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeContext, Directive } from "../types/runtime.js";
import { buildDecomposePrompt } from "./prompt-builder.js";
import { withCliPathFallback } from "./cli-tools.js";

const PLAN_SEPARATOR = "---PLAN---";

const DecomposedTaskSchema = z.object({
  task_id: z.string().regex(/^T\d{2,3}$/),
  title: z.string().min(1),
  description: z.string().default(""),
  task_size: z.enum(["small", "medium", "large"]).default("small"),
  priority: z.number().int().min(0).max(10).default(0),
  depends_on: z.array(z.string().regex(/^T\d{2,3}$/)).default([]),
});

const DecomposedTasksSchema = z.array(DecomposedTaskSchema).min(1).max(20);

interface DecomposeResult {
  tasks: z.infer<typeof DecomposedTasksSchema>;
  plan: string | null;
}

/**
 * Decompose a directive into tasks using Claude CLI in --print mode.
 * Updates directive status and creates task rows in the DB.
 * Optionally generates a Plan document in data/plans/.
 */
export async function decomposeDirective(
  ctx: RuntimeContext,
  directive: Directive
): Promise<void> {
  const { db, ws } = ctx;
  const now = Date.now();

  // Mark as decomposing
  db.prepare("UPDATE directives SET status = 'decomposing', updated_at = ? WHERE id = ?").run(now, directive.id);
  ws.broadcast("directive_update", { ...directive, status: "decomposing", updated_at: now });

  try {
    const prompt = buildDecomposePrompt(directive);
    const output = await runClaudeprint(prompt, directive.project_path);
    const { tasks, plan } = parseDecomposeOutput(output);

    // Validate dependency references
    const validatedTasks = validateDependencies(tasks);

    // Create tasks in DB
    const insertStmt = db.prepare(
      `INSERT INTO tasks (id, title, description, project_path, priority, task_size, directive_id, task_number, depends_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const t of validatedTasks) {
      const id = randomUUID();
      const ts = Date.now();
      const depsJson = t.depends_on.length > 0 ? JSON.stringify(t.depends_on) : null;
      insertStmt.run(id, t.title, t.description || null, directive.project_path ?? null, t.priority, t.task_size, directive.id, t.task_id, depsJson, ts, ts);
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      ws.broadcast("task_update", row);
    }

    // Write Plan document if available
    if (plan) {
      const planDir = join(process.cwd(), "data", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, `${directive.id}.md`), plan, "utf-8");
    }

    // Mark directive as active
    const finishTime = Date.now();
    db.prepare("UPDATE directives SET status = 'active', updated_at = ? WHERE id = ?").run(finishTime, directive.id);
    ws.broadcast("directive_update", { ...directive, status: "active", updated_at: finishTime });
  } catch (err) {
    // Revert to pending on failure
    const errTime = Date.now();
    db.prepare("UPDATE directives SET status = 'pending', updated_at = ? WHERE id = ?").run(errTime, directive.id);
    ws.broadcast("directive_update", { ...directive, status: "pending", updated_at: errTime });
    throw err;
  }
}

/**
 * Run claude CLI in --print mode (no interactive session, just text output).
 */
function runClaudeprint(prompt: string, cwd?: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE;
    cleanEnv.PATH = withCliPathFallback(String(cleanEnv.PATH ?? ""));
    cleanEnv.NO_COLOR = "1";
    cleanEnv.FORCE_COLOR = "0";

    const child = spawn("claude", ["--print"], {
      cwd: cwd ?? process.cwd(),
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude --print exited with code ${code}: ${stderr}`));
      }
    });

    child.on("error", reject);

    // Send prompt via stdin
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    // 2 minute timeout for decomposition
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      reject(new Error("Decomposition timed out after 120s"));
    }, 120_000);
  });
}

/**
 * Parse the output from Claude into tasks + optional plan.
 * Splits on ---PLAN--- separator. Falls back to tasks-only if separator is absent.
 */
function parseDecomposeOutput(output: string): DecomposeResult {
  const trimmed = output.trim();

  const sepIndex = trimmed.indexOf(PLAN_SEPARATOR);
  let jsonPart: string;
  let plan: string | null = null;

  if (sepIndex !== -1) {
    jsonPart = trimmed.slice(0, sepIndex).trim();
    plan = trimmed.slice(sepIndex + PLAN_SEPARATOR.length).trim();
    if (!plan) plan = null;
  } else {
    jsonPart = trimmed;
  }

  const tasks = parseJsonTasks(jsonPart);
  return { tasks, plan };
}

/**
 * Parse a JSON array of tasks from text, handling markdown fences and extra text.
 */
function parseJsonTasks(text: string): z.infer<typeof DecomposedTasksSchema> {
  // Try direct parse first
  try {
    const parsed = JSON.parse(text);
    return DecomposedTasksSchema.parse(parsed);
  } catch {
    // Try to find JSON array in the output
  }

  // Look for [...] in the output
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return DecomposedTasksSchema.parse(parsed);
    } catch {
      // fall through
    }
  }

  throw new Error(`Failed to parse decomposed tasks from output:\n${text.slice(0, 500)}`);
}

/**
 * Validate dependency references: ensure all depends_on IDs exist in the task set.
 * Also detect circular dependencies via topological sort.
 * Invalid references are removed with a warning log.
 */
function validateDependencies(
  tasks: z.infer<typeof DecomposedTasksSchema>
): z.infer<typeof DecomposedTasksSchema> {
  const validIds = new Set(tasks.map((t) => t.task_id));

  // Filter out invalid dependency references
  const cleaned = tasks.map((t) => {
    const validDeps = t.depends_on.filter((dep) => {
      if (!validIds.has(dep)) {
        console.warn(`[decomposer] Task ${t.task_id}: depends_on "${dep}" not found, removing`);
        return false;
      }
      return true;
    });
    return { ...t, depends_on: validDeps };
  });

  // Detect circular dependencies via topological sort
  if (hasCycle(cleaned)) {
    console.error("[decomposer] Circular dependency detected in task graph. Clearing all depends_on.");
    return cleaned.map((t) => ({ ...t, depends_on: [] }));
  }

  return cleaned;
}

/**
 * Check for cycles in the dependency graph using Kahn's algorithm.
 */
function hasCycle(tasks: z.infer<typeof DecomposedTasksSchema>): boolean {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const t of tasks) {
    inDegree.set(t.task_id, 0);
    adj.set(t.task_id, []);
  }

  for (const t of tasks) {
    for (const dep of t.depends_on) {
      adj.get(dep)?.push(t.task_id);
      inDegree.set(t.task_id, (inDegree.get(t.task_id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return processed !== tasks.length;
}
