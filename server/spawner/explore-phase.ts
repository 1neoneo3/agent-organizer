import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { Task, Agent } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { buildAgentArgs, EXPLORE_ALLOWED_TOOLS } from "./cli-tools.js";
import { buildExplorePrompt } from "./prompt-builder.js";
import { isOutputLanguage, type OutputLanguage } from "../config/runtime.js";

const EXPLORE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes max

interface ExploreSpawnResult {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
}

/**
 * Run an explore subprocess asynchronously and collect its full stdout/stderr.
 *
 * This replaces the previous `spawnSync` call, which blocked the Node event
 * loop for up to `EXPLORE_TIMEOUT_MS` (3 minutes). While blocked, the
 * server could not respond to any HTTP request — the UI would appear stuck
 * at "Loading..." for the entire explore phase.
 */
export function runExploreSubprocess(
  command: string,
  args: string[],
  opts: { cwd: string; input: string; env: NodeJS.ProcessEnv },
): Promise<ExploreSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, EXPLORE_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      stderr += `\n${err instanceof Error ? err.message : String(err)}`;
      resolve({ stdout, stderr, status: null, timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status: code, timedOut });
    });

    if (opts.input) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

export function buildExploreSpawnRequest(
  agent: Agent,
  task: Task,
  prompt: string,
): {
  command: string;
  args: string[];
  cwd: string;
  input: string;
  env: NodeJS.ProcessEnv;
} {
  const args = buildAgentArgs(agent.cli_provider, {
    model: agent.cli_model ?? undefined,
    allowedTools: EXPLORE_ALLOWED_TOOLS,
  });

  return {
    command: args[0],
    args: args.slice(1),
    cwd: task.project_path ?? process.cwd(),
    input: prompt,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      CI: "1",
    },
  };
}

/**
 * Run an Explore phase before the Implement phase.
 *
 * Spawns a short-lived agent with read-only tools to investigate the codebase,
 * then stores the result as a task log for the Implement agent to consume.
 *
 * Async / non-blocking: uses `spawn` + stream events so the Node event loop
 * keeps handling HTTP requests while the explore subprocess runs. The
 * previous `spawnSync` version froze the server for up to 3 minutes per
 * explore, which made the UI appear stuck at "Loading...".
 *
 * Returns the explore result text, or null if explore was skipped/failed.
 */
export async function runExplorePhase(
  db: DatabaseSync,
  ws: WsHub,
  agent: Agent,
  task: Task,
  // The stage of the spawn that owns this explore run (typically
  // "in_progress", but "refinement" when explore precedes refinement).
  // Passed from the caller so log rows carry the correct stage instead
  // of relying on the trigger fallback, which races with status
  // transitions later in performFinalization.
  spawnStage: string,
): Promise<string | null> {
  // Check if explore_phase is enabled
  const exploreSetting = db.prepare(
    "SELECT value FROM settings WHERE key = 'explore_phase'"
  ).get() as { value: string } | undefined;

  if (exploreSetting?.value !== "true") {
    return null;
  }

  // Skip explore for small tasks, review runs, QA runs, and continue prompts
  if (
    task.task_size === "small" ||
    task.status === "qa_testing" ||
    task.status === "pr_review"
  ) {
    return null;
  }

  const languageSetting = db.prepare(
    "SELECT value FROM settings WHERE key = 'output_language'",
  ).get() as { value: string } | undefined;
  const language: OutputLanguage =
    languageSetting?.value && isOutputLanguage(languageSetting.value)
      ? languageSetting.value
      : "ja";

  const prompt = buildExplorePrompt(task, language);
  const request = buildExploreSpawnRequest(agent, task, prompt);

  const logMsg = `[Explore Phase] Starting read-only investigation with ${agent.name}`;
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'system', ?, ?, ?)"
  ).run(task.id, logMsg, spawnStage, agent.id);
  ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: logMsg }], { taskId: task.id });

  try {
    const result = await runExploreSubprocess(request.command, request.args, {
      cwd: request.cwd,
      input: request.input,
      env: request.env,
    });

    const output = result.stdout.trim();

    if (result.status !== 0 || !output) {
      const reason = result.timedOut ? "timed out" : `exit ${result.status}`;
      const errMsg = `[Explore Phase] Failed (${reason}): ${result.stderr.slice(0, 500)}`;
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'system', ?, ?, ?)"
      ).run(task.id, errMsg, spawnStage, agent.id);
      ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: errMsg }], { taskId: task.id });
      return null;
    }

    // Extract the structured explore result
    const exploreMatch = output.match(/---EXPLORE RESULT---[\s\S]*?---END EXPLORE---/);
    const exploreResult = exploreMatch ? exploreMatch[0] : output.slice(-3000);

    // Store as task log for the Implement phase
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'system', ?, ?, ?)"
    ).run(task.id, `[EXPLORE] ${exploreResult}`, spawnStage, agent.id);

    const doneMsg = `[Explore Phase] Completed. ${exploreResult.length} chars of context captured.`;
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'system', ?, ?, ?)"
    ).run(task.id, doneMsg, spawnStage, agent.id);
    ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: doneMsg }], { taskId: task.id });

    return exploreResult;
  } catch (error) {
    const errMsg = `[Explore Phase] Error: ${error instanceof Error ? error.message : String(error)}`;
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message, stage, agent_id) VALUES (?, 'system', ?, ?, ?)"
    ).run(task.id, errMsg, spawnStage, agent.id);
    ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: errMsg }], { taskId: task.id });
    return null;
  }
}
