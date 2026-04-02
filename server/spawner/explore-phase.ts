import { spawnSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { Task, Agent } from "../types/runtime.js";
import type { WsHub } from "../ws/hub.js";
import { buildAgentArgs, EXPLORE_ALLOWED_TOOLS } from "./cli-tools.js";
import { buildExplorePrompt } from "./prompt-builder.js";

const EXPLORE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes max

/**
 * Run an Explore phase synchronously before the Implement phase.
 *
 * Spawns a short-lived agent with read-only tools to investigate the codebase,
 * then stores the result as a task log for the Implement agent to consume.
 *
 * Returns the explore result text, or null if explore was skipped/failed.
 */
export function runExplorePhase(
  db: DatabaseSync,
  ws: WsHub,
  agent: Agent,
  task: Task,
): string | null {
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

  const prompt = buildExplorePrompt(task);
  const args = buildAgentArgs(agent.cli_provider, {
    model: agent.cli_model ?? undefined,
    allowedTools: EXPLORE_ALLOWED_TOOLS,
  });

  const logMsg = `[Explore Phase] Starting read-only investigation with ${agent.name}`;
  db.prepare(
    "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
  ).run(task.id, logMsg);
  ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: logMsg }], { taskId: task.id });

  try {
    const result = spawnSync(args[0], [...args.slice(1), "-p", prompt], {
      cwd: task.project_path ?? process.cwd(),
      encoding: "utf-8",
      timeout: EXPLORE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CI: "1",
      },
    });

    const output = (result.stdout ?? "").trim();

    if (result.status !== 0 || !output) {
      const errMsg = `[Explore Phase] Failed (exit ${result.status}): ${(result.stderr ?? "").slice(0, 500)}`;
      db.prepare(
        "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
      ).run(task.id, errMsg);
      ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: errMsg }], { taskId: task.id });
      return null;
    }

    // Extract the structured explore result
    const exploreMatch = output.match(/---EXPLORE RESULT---[\s\S]*?---END EXPLORE---/);
    const exploreResult = exploreMatch ? exploreMatch[0] : output.slice(-3000);

    // Store as task log for the Implement phase
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, `[EXPLORE] ${exploreResult}`);

    const doneMsg = `[Explore Phase] Completed. ${exploreResult.length} chars of context captured.`;
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, doneMsg);
    ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: doneMsg }], { taskId: task.id });

    return exploreResult;
  } catch (error) {
    const errMsg = `[Explore Phase] Error: ${error instanceof Error ? error.message : String(error)}`;
    db.prepare(
      "INSERT INTO task_logs (task_id, kind, message) VALUES (?, 'system', ?)"
    ).run(task.id, errMsg);
    ws.broadcast("cli_output", [{ task_id: task.id, kind: "system", message: errMsg }], { taskId: task.id });
    return null;
  }
}
