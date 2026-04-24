import { spawnSync } from "node:child_process";
import {
  detectHookCachePolicy,
  recordHookSuccess,
  shouldSkipHook,
} from "./hook-cache.js";

export interface WorkflowHookResult {
  command: string;
  ok: boolean;
  output: string;
  skipped: boolean;
  cachePolicyId?: string;
  cacheKeyFiles?: readonly string[];
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
    const cachePolicy = detectHookCachePolicy(command);
    const cacheKeyFiles = cachePolicy?.files;

    if (cacheDir && shouldSkipHook(command, cwd, cacheDir)) {
      results.push({
        command,
        ok: true,
        output: "",
        skipped: true,
        cachePolicyId: cachePolicy?.id,
        cacheKeyFiles,
      });
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

    results.push({
      command,
      ok,
      output,
      skipped: false,
      cachePolicyId: cachePolicy?.id,
      cacheKeyFiles,
    });
  }

  return results;
}
