import { spawnSync } from "node:child_process";

export interface WorkflowHookResult {
  command: string;
  ok: boolean;
  output: string;
}

export function runWorkflowHooks(commands: string[], cwd: string): WorkflowHookResult[] {
  const results: WorkflowHookResult[] = [];

  for (const command of commands) {
    const run = spawnSync("bash", ["-lc", command], {
      cwd,
      encoding: "utf-8",
      env: process.env,
    });

    const output = [run.stdout, run.stderr]
      .filter((chunk): chunk is string => Boolean(chunk))
      .join("\n")
      .trim();

    results.push({
      command,
      ok: run.status === 0,
      output,
    });
  }

  return results;
}
