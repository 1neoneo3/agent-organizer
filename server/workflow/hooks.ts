import { spawnSync } from "node:child_process";
import { shouldSkipHook, recordHookSuccess } from "./hook-cache.js";

export interface WorkflowHookResult {
  command: string;
  ok: boolean;
  output: string;
  skipped: boolean;
}

export interface RunHooksOptions {
  cacheDir?: string;
}

export function runWorkflowHooks(
  commands: string[],
  cwd: string,
  options?: RunHooksOptions,
): WorkflowHookResult[] {
  const results: WorkflowHookResult[] = [];
  const cacheDir = options?.cacheDir;

  for (const command of commands) {
    if (cacheDir && shouldSkipHook(command, cwd, cacheDir)) {
      results.push({ command, ok: true, output: "", skipped: true });
      continue;
    }

    const run = spawnSync("bash", ["-lc", command], {
      cwd,
      encoding: "utf-8",
      env: process.env,
    });

    const output = [run.stdout, run.stderr]
      .filter((chunk): chunk is string => Boolean(chunk))
      .join("\n")
      .trim();

    const ok = run.status === 0;

    if (ok && cacheDir) {
      recordHookSuccess(command, cwd, cacheDir);
    }

    results.push({ command, ok, output, skipped: false });
  }

  return results;
}
