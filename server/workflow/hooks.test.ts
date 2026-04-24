import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runWorkflowHooks } from "./hooks.js";
import { recordHookSuccess } from "./hook-cache.js";

describe("runWorkflowHooks", () => {
  it("runs commands in the target workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-hooks-"));
    const filePath = join(dir, "hook.txt");

    const results = runWorkflowHooks([`printf "ok" > "${filePath}"`], dir);

    assert.equal(results[0]?.ok, true);
    assert.equal(results[0]?.skipped, false);
    assert.equal(existsSync(filePath), true);
    assert.equal(readFileSync(filePath, "utf-8"), "ok");
  });

  it("captures failures without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-hooks-"));

    const results = runWorkflowHooks(["exit 7"], dir);

    assert.equal(results[0]?.ok, false);
    assert.equal(results[0]?.skipped, false);
  });

  it("skips cached install hooks when fingerprint matches", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-cache-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");

    recordHookSuccess("pnpm install", cwd, cacheDir);

    const results = runWorkflowHooks(
      ["pnpm install"],
      cwd,
      { cacheDir },
    );
    assert.equal(results[0]?.ok, true);
    assert.equal(results[0]?.skipped, true);
    assert.equal(results[0]?.output, "");
  });

  it("does not skip when dependency files change after cache", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-cache-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");

    recordHookSuccess("pnpm install", cwd, cacheDir);

    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\nnew-dep: 1.0");

    const results = runWorkflowHooks(
      ["pnpm install"],
      cwd,
      { cacheDir },
    );
    assert.equal(results[0]?.skipped, false);
  });

  it("does not cache unknown commands", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));

    runWorkflowHooks(["echo hello"], cwd, { cacheDir });
    const second = runWorkflowHooks(["echo hello"], cwd, { cacheDir });

    assert.equal(second[0]?.skipped, false);
    assert.equal(second[0]?.ok, true);
  });
});
