import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentEnvironment } from "./env.js";

describe("buildAgentEnvironment", () => {
  it("does not leak production npm settings into task processes", () => {
    const env = buildAgentEnvironment({
      PATH: "/usr/bin",
      NODE_ENV: "production",
      npm_config_omit: "dev",
      NPM_CONFIG_OMIT: "dev",
      npm_config_only: "production",
      NPM_CONFIG_ONLY: "production",
      CLAUDECODE: "1",
      CLAUDE_CODE: "1",
    });

    assert.equal(env.NODE_ENV, undefined);
    assert.equal(env.npm_config_omit, undefined);
    assert.equal(env.NPM_CONFIG_OMIT, undefined);
    assert.equal(env.npm_config_only, undefined);
    assert.equal(env.NPM_CONFIG_ONLY, undefined);
    assert.equal(env.npm_config_production, "false");
    assert.equal(env.NPM_CONFIG_PRODUCTION, "false");
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE, undefined);
    assert.equal(env.CI, "1");
    assert.equal(env.NO_COLOR, "1");
    assert.equal(env.FORCE_COLOR, "0");
  });
});
