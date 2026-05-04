import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  loadProjectEnv,
  isOutputLanguage,
  VALID_OUTPUT_LANGUAGES,
  SETTINGS_DEFAULTS,
} from "./runtime.js";

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

describe("VALID_OUTPUT_LANGUAGES", () => {
  it("contains exactly ja and en", () => {
    assert.deepEqual([...VALID_OUTPUT_LANGUAGES], ["ja", "en"]);
  });
});

describe("SETTINGS_DEFAULTS.output_language", () => {
  it("defaults to ja", () => {
    assert.equal(SETTINGS_DEFAULTS.output_language, "ja");
  });
});

describe("SETTINGS_DEFAULTS.enable_controller_mode", () => {
  it("defaults to false", () => {
    assert.equal(SETTINGS_DEFAULTS.enable_controller_mode, "false");
  });
});

describe("isOutputLanguage", () => {
  it("returns true for 'ja'", () => {
    assert.equal(isOutputLanguage("ja"), true);
  });

  it("returns true for 'en'", () => {
    assert.equal(isOutputLanguage("en"), true);
  });

  it("returns false for unsupported languages", () => {
    assert.equal(isOutputLanguage("fr"), false);
    assert.equal(isOutputLanguage("zh"), false);
    assert.equal(isOutputLanguage(""), false);
  });

  it("returns false for mixed-case variants", () => {
    assert.equal(isOutputLanguage("JA"), false);
    assert.equal(isOutputLanguage("En"), false);
  });
});
