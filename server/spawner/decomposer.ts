import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeContext, Directive } from "../types/runtime.js";
import { buildDecomposePrompt } from "./prompt-builder.js";
import { withCliPathFallback } from "./cli-tools.js";
import { isOutputLanguage, type OutputLanguage } from "../config/runtime.js";
import { pickTaskUpdate } from "../ws/update-payloads.js";
import { CONTROLLER_STAGES, isControllerModeEnabled, type ControllerStage } from "../controller/orchestrator.js";

const PLAN_SEPARATOR = "---PLAN---";
const MAX_LOG_LINES = 500;

export interface DecomposeLogEntry {
  directive_id: string;
  kind: "stdout" | "stderr" | "system";
  message: string;
  ts: number;
}

/** In-memory buffer for decompose logs, keyed by directive ID */
const decomposeLogBuffers = new Map<string, DecomposeLogEntry[]>();

export function getDecomposeLogs(directiveId: string): DecomposeLogEntry[] {
  return decomposeLogBuffers.get(directiveId) ?? [];
}

function appendLog(directiveId: string, kind: DecomposeLogEntry["kind"], message: string): DecomposeLogEntry {
  const entry: DecomposeLogEntry = { directive_id: directiveId, kind, message, ts: Date.now() };
  let buf = decomposeLogBuffers.get(directiveId);
  if (!buf) {
    buf = [];
    decomposeLogBuffers.set(directiveId, buf);
  }
  buf.push(entry);
  // Trim oldest entries if over limit
  if (buf.length > MAX_LOG_LINES) {
    buf.splice(0, buf.length - MAX_LOG_LINES);
  }
  return entry;
}

function normalizeWriteScope(scope: readonly string[] | undefined): string[] {
  return [...new Set((scope ?? []).map((item) => item.trim()).filter(Boolean))].sort();
}

const DecomposedTaskSchema = z.object({
  task_id: z.string().regex(/^T\d{2,3}$/),
  title: z.string().min(1),
  description: z.string().default(""),
  task_size: z.enum(["small", "medium", "large"]).default("small"),
  priority: z.number().int().min(0).max(10).default(0),
  depends_on: z.array(z.string().regex(/^T\d{2,3}$/)).default([]),
  controller_stage: z.enum(CONTROLLER_STAGES).optional(),
  write_scope: z.array(z.string().min(1)).default([]),
});

const DecomposedTasksSchema = z.array(DecomposedTaskSchema).min(1).max(20);

interface DecomposeResult {
  tasks: z.infer<typeof DecomposedTasksSchema>;
  plan: string | null;
}

function controllerStageForTask(
  task: z.infer<typeof DecomposedTaskSchema>,
  controllerMode: boolean,
): ControllerStage | null {
  if (!controllerMode) return null;
  return task.controller_stage ?? "implement";
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
    // Broadcast start
    const startEntry = appendLog(directive.id, "system", "Decomposition started");
    ws.broadcast("decompose_output", startEntry);

    const languageRow = db.prepare(
      "SELECT value FROM settings WHERE key = 'output_language'",
    ).get() as { value: string } | undefined;
    const language: OutputLanguage =
      languageRow?.value && isOutputLanguage(languageRow.value)
        ? languageRow.value
        : "ja";

    const prompt = buildDecomposePrompt(directive, language);
    const output = await runClaudeprint({
      prompt,
      cwd: directive.project_path,
      onChunk: (stream, text) => {
        const entry = appendLog(directive.id, stream === "stdout" ? "stdout" : "stderr", text);
        ws.broadcast("decompose_output", entry);
      },
    });
    const { tasks, plan } = parseDecomposeOutput(output);

    // Validate dependency references
    const validatedTasks = validateDependencies(tasks);

    const controllerMode = directive.controller_mode === 1 && isControllerModeEnabled(db);

    // Create tasks in DB
    const insertStmt = db.prepare(
      `INSERT INTO tasks (
         id, title, description, project_path, priority, task_size,
         directive_id, task_number, depends_on, controller_stage, write_scope, planned_files,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const t of validatedTasks) {
      const id = randomUUID();
      const ts = Date.now();
      const depsJson = t.depends_on.length > 0 ? JSON.stringify(t.depends_on) : null;
      const controllerStage = controllerStageForTask(t, controllerMode);
      const writeScope = controllerMode ? normalizeWriteScope(t.write_scope) : [];
      const writeScopeJson = writeScope.length > 0 ? JSON.stringify(writeScope) : null;
      insertStmt.run(
        id,
        t.title,
        t.description || null,
        directive.project_path ?? null,
        t.priority,
        t.task_size,
        directive.id,
        t.task_id,
        depsJson,
        controllerStage,
        writeScopeJson,
        writeScopeJson,
        ts,
        ts,
      );
      ws.broadcast(
        "task_update",
        pickTaskUpdate(
          {
            id,
            title: t.title,
            project_path: directive.project_path ?? null,
            status: "inbox",
            priority: t.priority,
            task_size: t.task_size,
            task_number: t.task_id,
            depends_on: depsJson,
            controller_stage: controllerStage,
            directive_id: directive.id,
            created_at: ts,
            updated_at: ts,
          },
          [
            "title",
            "project_path",
            "status",
            "priority",
            "task_size",
            "task_number",
            "depends_on",
            "controller_stage",
            "directive_id",
            "created_at",
            "updated_at",
          ],
        ),
      );
    }

    // Write Plan document if available
    if (plan) {
      const planDir = join(process.cwd(), "data", "plans");
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, `${directive.id}.md`), plan, "utf-8");
    }

    // Broadcast completion
    const doneEntry = appendLog(directive.id, "system", `Decomposition complete: ${tasks.length} tasks created`);
    ws.broadcast("decompose_output", doneEntry);

    // Mark directive as active
    const finishTime = Date.now();
    const firstControllerStage =
      controllerMode
        ? CONTROLLER_STAGES.find((stage) =>
            validatedTasks.some((task) => controllerStageForTask(task, controllerMode) === stage),
          ) ?? "implement"
        : null;
    db.prepare(
      "UPDATE directives SET status = 'active', controller_stage = COALESCE(?, controller_stage), updated_at = ? WHERE id = ?",
    ).run(firstControllerStage, finishTime, directive.id);
    ws.broadcast("directive_update", {
      ...directive,
      status: "active",
      controller_stage: firstControllerStage ?? directive.controller_stage,
      updated_at: finishTime,
    });
  } catch (err) {
    // Broadcast error
    const errMsg = err instanceof Error ? err.message : String(err);
    const errEntry = appendLog(directive.id, "system", `Decomposition failed: ${errMsg}`);
    ws.broadcast("decompose_output", errEntry);

    // Revert to pending on failure
    const errTime = Date.now();
    db.prepare("UPDATE directives SET status = 'pending', updated_at = ? WHERE id = ?").run(errTime, directive.id);
    ws.broadcast("directive_update", { ...directive, status: "pending", updated_at: errTime });
    throw err;
  } finally {
    // Clean up buffer after 5 minutes
    setTimeout(() => {
      decomposeLogBuffers.delete(directive.id);
    }, 5 * 60 * 1000);
  }
}

/**
 * Run claude CLI in --print mode with stream-json output for real-time streaming.
 * Parses JSONL lines: extracts text chunks for onChunk, returns final result text.
 */
interface RunClaudePrintOptions {
  prompt: string;
  cwd?: string | null;
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
}

function runClaudeprint({ prompt, cwd, onChunk }: RunClaudePrintOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.CLAUDE_CODE;
    cleanEnv.PATH = withCliPathFallback(String(cleanEnv.PATH ?? ""));
    cleanEnv.NO_COLOR = "1";
    cleanEnv.FORCE_COLOR = "0";

    const child = spawn("claude", [
      "--print", "--model", "claude-opus-4-6",
      "--output-format", "stream-json", "--verbose",
      "--include-partial-messages",
      "--tools", "",
      "--no-session-persistence",
      "--disable-slash-commands",
    ], {
      cwd: cwd ?? process.cwd(),
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let resultText = "";
    let stderr = "";
    let lineBuf = "";
    // Track previously seen text length to emit only deltas
    let lastSeenTextLen = 0;

    // Parse each JSONL line from stdout
    function processLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const evt = JSON.parse(trimmed);

        // assistant message with text content
        // With --include-partial-messages, each event contains cumulative text.
        // We emit only the delta (new characters since last event).
        if (evt.type === "assistant" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === "text" && typeof block.text === "string") {
              const fullText = block.text;
              if (fullText.length > lastSeenTextLen) {
                const delta = fullText.slice(lastSeenTextLen);
                onChunk?.("stdout", delta);
                lastSeenTextLen = fullText.length;
              }
            }
          }
        }

        // final result → capture the full text
        if (evt.type === "result" && typeof evt.result === "string") {
          resultText = evt.result;
        }
      } catch {
        // Not valid JSON, forward raw line
        onChunk?.("stdout", trimmed);
      }
    }

    child.stdout?.on("data", (data: Buffer) => {
      lineBuf += data.toString("utf8");
      const lines = lineBuf.split("\n");
      // Keep last incomplete line in buffer
      lineBuf = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderr += text;
      onChunk?.("stderr", text);
    });

    child.on("close", (code) => {
      // Process any remaining buffered line
      if (lineBuf.trim()) processLine(lineBuf);

      if (code === 0 && resultText) {
        resolve(resultText);
      } else if (code === 0) {
        reject(new Error("claude --print stream-json: no result event received"));
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

    // 10 minute timeout for Opus 4.6 decomposition
    setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      reject(new Error("Decomposition timed out after 600s"));
    }, 600_000);
  });
}

/**
 * Parse the output from Claude into tasks + optional plan.
 * Splits on ---PLAN--- separator. Falls back to tasks-only if separator is absent.
 */
export function parseDecomposeOutput(output: string): DecomposeResult {
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
