import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeContext, Directive } from "../types/runtime.js";
import { buildDecomposePrompt } from "./prompt-builder.js";
import { withCliPathFallback } from "./cli-tools.js";

const DecomposedTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(""),
  task_size: z.enum(["small", "medium", "large"]).default("small"),
  priority: z.number().int().min(0).max(10).default(0),
});

const DecomposedTasksSchema = z.array(DecomposedTaskSchema).min(1).max(20);

/**
 * Decompose a directive into tasks using Claude CLI in --print mode.
 * Updates directive status and creates task rows in the DB.
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
    const tasks = parseDecomposedTasks(output);

    // Create tasks in DB
    const insertStmt = db.prepare(
      `INSERT INTO tasks (id, title, description, project_path, priority, task_size, directive_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const createdTasks = [];
    for (const t of tasks) {
      const id = randomUUID();
      const ts = Date.now();
      insertStmt.run(id, t.title, t.description || null, directive.project_path ?? null, t.priority, t.task_size, directive.id, ts, ts);
      const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
      createdTasks.push(row);
      ws.broadcast("task_update", row);
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
 * Parse the JSON output from Claude into validated task objects.
 */
function parseDecomposedTasks(output: string): z.infer<typeof DecomposedTasksSchema> {
  // Try to extract JSON array from the output
  const trimmed = output.trim();

  // Try direct parse first
  try {
    const parsed = JSON.parse(trimmed);
    return DecomposedTasksSchema.parse(parsed);
  } catch {
    // Try to find JSON array in the output
  }

  // Look for [...] in the output
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      return DecomposedTasksSchema.parse(parsed);
    } catch {
      // fall through
    }
  }

  throw new Error(`Failed to parse decomposed tasks from output:\n${trimmed.slice(0, 500)}`);
}
