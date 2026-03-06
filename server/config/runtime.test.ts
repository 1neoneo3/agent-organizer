import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadProjectEnv } from "./runtime.js";

const ORIGINAL_ENV = {
  REDIS_ENABLED: process.env.REDIS_ENABLED,
  PORT: process.env.PORT,
};

afterEach(() => {
  if (ORIGINAL_ENV.REDIS_ENABLED === undefined) {
    delete process.env.REDIS_ENABLED;
  } else {
    process.env.REDIS_ENABLED = ORIGINAL_ENV.REDIS_ENABLED;
  }

  if (ORIGINAL_ENV.PORT === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = ORIGINAL_ENV.PORT;
  }
});

describe("loadProjectEnv", () => {
  it("loads values from an env file when the process env is unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-organizer-runtime-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "REDIS_ENABLED=false\nPORT=9999\n");

    delete process.env.REDIS_ENABLED;
    delete process.env.PORT;

    loadProjectEnv(envPath);

    assert.equal(process.env.REDIS_ENABLED, "false");
    assert.equal(process.env.PORT, "9999");
  });

  it("does not overwrite existing process env values", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-organizer-runtime-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "REDIS_ENABLED=false\nPORT=9999\n");

    process.env.REDIS_ENABLED = "true";
    process.env.PORT = "1234";

    loadProjectEnv(envPath);

    assert.equal(process.env.REDIS_ENABLED, "true");
    assert.equal(process.env.PORT, "1234");
  });
});
