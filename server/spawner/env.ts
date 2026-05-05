import { withCliPathFallback } from "./cli-tools.js";

/**
 * Environment shared by AO-spawned agents and workflow hooks.
 *
 * AO itself is commonly started with NODE_ENV=production, but task
 * workspaces need devDependencies for lint/build/test. Do not let the
 * server's production npm settings leak into child processes.
 */
export function buildAgentEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };

  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  delete env.NODE_ENV;
  delete env.npm_config_omit;
  delete env.NPM_CONFIG_OMIT;
  delete env.npm_config_only;
  delete env.NPM_CONFIG_ONLY;
  env.npm_config_production = "false";
  env.NPM_CONFIG_PRODUCTION = "false";

  env.PATH = withCliPathFallback(String(env.PATH ?? ""));
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  env.CI = "1";
  if (!env.TERM) env.TERM = "dumb";

  return env;
}
