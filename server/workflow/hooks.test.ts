import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runWorkflowHooks } from "./hooks.js";
import { recordHookSuccess, shouldSkipHook } from "./hook-cache.js";

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
    assert.equal(results[0]?.cachePolicyId, "pnpm-install");
    assert.deepEqual(results[0]?.cacheKeyFiles, [
      "pnpm-lock.yaml",
      "package.json",
    ]);
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

  it("returns empty array for empty commands", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-"));
    const results = runWorkflowHooks([], cwd);
    assert.deepEqual(results, []);
  });

  it("does not skip anything when cacheDir is omitted", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-nocache-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");

    recordHookSuccess("pnpm install --frozen-lockfile", cwd, cacheDir);

    const results = runWorkflowHooks(
      ["pnpm install --frozen-lockfile"],
      cwd,
    );
    assert.equal(results[0]?.skipped, false);
  });

  it("failed install hook is NOT recorded in cache", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-fail-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");

    runWorkflowHooks(
      ["pnpm install && exit 1"],
      cwd,
      { cacheDir },
    );

    assert.equal(
      shouldSkipHook("pnpm install && exit 1", cwd, cacheDir),
      false,
    );
  });

  it("handles mixed cached and non-cached commands", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-mix-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");

    recordHookSuccess("pnpm install", cwd, cacheDir);

    const results = runWorkflowHooks(
      ["pnpm install", "echo setup"],
      cwd,
      { cacheDir },
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]?.skipped, true);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.skipped, false);
    assert.equal(results[1]?.ok, true);
    assert.equal(results[1]?.cachePolicyId, undefined);
  });

  it("returns cache metadata for codegen hooks", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-codegen-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "codegen.yml"), "schema: schema.graphql");
    writeFileSync(join(cwd, "schema.graphql"), "type Query { hello: String }");

    recordHookSuccess("pnpm run codegen", cwd, cacheDir);

    const second = runWorkflowHooks(["pnpm run codegen"], cwd, { cacheDir });

    assert.equal(second[0]?.skipped, true);
    assert.equal(second[0]?.cachePolicyId, "codegen");
    assert.ok(second[0]?.cacheKeyFiles?.includes("codegen.yml"));
  });

  it("successful chained install records cache and skips on next run", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-roundtrip-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    const marker = join(cwd, "marker.txt");
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");
    const command = `printf x >> "${marker}" && CI=1 pnpm install --help`;

    const first = runWorkflowHooks(
      [command],
      cwd,
      { cacheDir },
    );

    assert.equal(first[0]?.skipped, false);
    assert.equal(first[0]?.ok, true);
    assert.equal(readFileSync(marker, "utf-8"), "x");

    const cacheFiles = readdirSync(cacheDir).filter((f) =>
      f.endsWith(".json"),
    );
    assert.equal(cacheFiles.length, 1);

    const second = runWorkflowHooks(
      [command],
      cwd,
      { cacheDir },
    );
    assert.equal(second[0]?.skipped, true);
    assert.equal(readFileSync(marker, "utf-8"), "x");
  });

  it("skipping cached chained install hook improves wall time", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-elapsed-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "ao-hooks-cachedir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const command = "sleep 0.2 && CI=1 pnpm install --help";

    const firstStarted = Date.now();
    const first = runWorkflowHooks([command], cwd, { cacheDir });
    const firstElapsed = Date.now() - firstStarted;

    const secondStarted = Date.now();
    const second = runWorkflowHooks([command], cwd, { cacheDir });
    const secondElapsed = Date.now() - secondStarted;

    assert.equal(first[0]?.ok, true);
    assert.equal(first[0]?.skipped, false);
    assert.equal(second[0]?.ok, true);
    assert.equal(second[0]?.skipped, true);
    assert.ok(firstElapsed >= 150, `expected uncached run to take at least 150ms, got ${firstElapsed}ms`);
    assert.ok(secondElapsed < 100, `expected cached run to skip quickly, got ${secondElapsed}ms`);
  });

  it("captures stderr in output", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-stderr-"));
    const results = runWorkflowHooks(["echo err >&2"], cwd);

    assert.equal(results[0]?.ok, true);
    assert.ok(results[0]?.output.includes("err"));
  });

  it("runs commands sequentially and stops reporting on all", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ao-hooks-seq-"));
    const results = runWorkflowHooks(
      ["exit 1", "echo second"],
      cwd,
    );

    assert.equal(results.length, 2);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[1]?.ok, true);
  });
});
