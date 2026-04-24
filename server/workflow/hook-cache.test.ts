import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  computeFingerprint,
  detectDependencyFiles,
  detectHookCachePolicy,
  invalidateHookCache,
  recordHookSuccess,
  shouldSkipHook,
} from "./hook-cache.js";

describe("detectDependencyFiles", () => {
  it("detects pnpm install dependency files", () => {
    const files = detectDependencyFiles("pnpm install");
    assert.ok(files);
    assert.ok(files.includes("pnpm-lock.yaml"));
    assert.ok(files.includes("package.json"));
  });

  it("detects npm ci dependency files", () => {
    const files = detectDependencyFiles("npm ci");
    assert.ok(files);
    assert.ok(files.includes("package-lock.json"));
    assert.ok(files.includes("package.json"));
  });

  it("detects npm install dependency files", () => {
    const files = detectDependencyFiles("npm install");
    assert.ok(files);
    assert.ok(files.includes("package-lock.json"));
  });

  it("detects yarn install dependency files", () => {
    const files = detectDependencyFiles("yarn install");
    assert.ok(files);
    assert.ok(files.includes("yarn.lock"));
  });

  it("detects pip install -r dependency files", () => {
    const files = detectDependencyFiles("pip install -r requirements.txt");
    assert.ok(files);
    assert.ok(files.includes("requirements.txt"));
  });

  it("detects poetry install dependency files", () => {
    const files = detectDependencyFiles("poetry install");
    assert.ok(files);
    assert.ok(files.includes("poetry.lock"));
    assert.ok(files.includes("pyproject.toml"));
  });

  it("detects bundle install dependency files", () => {
    const files = detectDependencyFiles("bundle install");
    assert.ok(files);
    assert.ok(files.includes("Gemfile.lock"));
    assert.ok(files.includes("Gemfile"));
  });

  it("returns null for unknown commands", () => {
    assert.equal(detectDependencyFiles("echo hello"), null);
    assert.equal(detectDependencyFiles("git status"), null);
    assert.equal(detectDependencyFiles("pnpm lint"), null);
  });

  it("handles commands with flags", () => {
    const files = detectDependencyFiles("pnpm install --frozen-lockfile");
    assert.ok(files);
    assert.ok(files.includes("pnpm-lock.yaml"));
  });

  it("detects install hooks inside chained shell commands", () => {
    const files = detectDependencyFiles(
      "cd packages/api && CI=1 pnpm install --frozen-lockfile",
    );
    assert.ok(files);
    assert.ok(files.includes("pnpm-lock.yaml"));
    assert.ok(files.includes("package.json"));
  });

  it("detects short alias: pnpm i", () => {
    const files = detectDependencyFiles("pnpm i");
    assert.ok(files);
    assert.ok(files.includes("pnpm-lock.yaml"));
    assert.ok(files.includes("package.json"));
  });

  it("detects short alias: npm i", () => {
    const files = detectDependencyFiles("npm i");
    assert.ok(files);
    assert.ok(files.includes("package-lock.json"));
    assert.ok(files.includes("package.json"));
  });

  it("trims leading/trailing whitespace", () => {
    const files = detectDependencyFiles("  pnpm install  ");
    assert.ok(files);
    assert.ok(files.includes("pnpm-lock.yaml"));
  });

  it("does not match partial command names", () => {
    assert.equal(detectDependencyFiles("pnpm-install"), null);
    assert.equal(detectDependencyFiles("npmi"), null);
  });

  it("returns a new array each call (no shared mutation)", () => {
    const a = detectDependencyFiles("pnpm install");
    const b = detectDependencyFiles("pnpm install");
    assert.ok(a);
    assert.ok(b);
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  it("detects codegen dependency files", () => {
    const policy = detectHookCachePolicy("pnpm run codegen");
    assert.ok(policy);
    assert.equal(policy.id, "codegen");
    assert.ok(policy.files.includes("codegen.yml"));
    assert.ok(policy.files.includes("schema.graphql"));
  });
});

describe("computeFingerprint", () => {
  it("returns null for unknown commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    assert.equal(computeFingerprint("echo hello", dir), null);
    rmSync(dir, { recursive: true });
  });

  it("computes a fingerprint from dependency files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const fp = computeFingerprint("pnpm install", dir);
    assert.ok(fp);
    assert.equal(typeof fp, "string");
    assert.ok(fp.length > 0);

    rmSync(dir, { recursive: true });
  });

  it("changes when a dependency file changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const fp1 = computeFingerprint("pnpm install", dir);

    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\nnew-dep: 1.0");
    const fp2 = computeFingerprint("pnpm install", dir);

    assert.notEqual(fp1, fp2);

    rmSync(dir, { recursive: true });
  });

  it("handles missing dependency files gracefully", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));

    const fp = computeFingerprint("pnpm install", dir);
    assert.ok(fp);

    rmSync(dir, { recursive: true });
  });

  it("is deterministic for identical inputs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const fp1 = computeFingerprint("pnpm install", dir);
    const fp2 = computeFingerprint("pnpm install", dir);
    assert.equal(fp1, fp2);

    rmSync(dir, { recursive: true });
  });

  it("differs for different commands even with same dependency files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "package-lock.json"), "{}");
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const fpPnpm = computeFingerprint("pnpm install", dir);
    const fpNpm = computeFingerprint("npm install", dir);
    assert.ok(fpPnpm);
    assert.ok(fpNpm);
    assert.notEqual(fpPnpm, fpNpm);

    rmSync(dir, { recursive: true });
  });

  it("changes when package.json changes (not just lockfile)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    writeFileSync(join(dir, "package.json"), '{"name":"v1"}');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const fp1 = computeFingerprint("pnpm install", dir);

    writeFileSync(join(dir, "package.json"), '{"name":"v2"}');
    const fp2 = computeFingerprint("pnpm install", dir);

    assert.notEqual(fp1, fp2);

    rmSync(dir, { recursive: true });
  });

  it("computes fingerprints for chained install commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

    const fp = computeFingerprint(
      "cd . && CI=1 pnpm install --frozen-lockfile",
      dir,
    );
    assert.ok(fp);

    rmSync(dir, { recursive: true });
  });

  it("changes when subdir install dependencies change", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    mkdirSync(join(dir, "packages", "api"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"root"}');
    writeFileSync(join(dir, "pnpm-lock.yaml"), "root-lockfile");
    writeFileSync(join(dir, "packages", "api", "package.json"), '{"name":"api"}');
    writeFileSync(
      join(dir, "packages", "api", "pnpm-lock.yaml"),
      "api-lockfile-v1",
    );

    const command = "cd packages/api && pnpm install --frozen-lockfile";
    const fp1 = computeFingerprint(command, dir);

    writeFileSync(
      join(dir, "packages", "api", "pnpm-lock.yaml"),
      "api-lockfile-v2",
    );
    const fp2 = computeFingerprint(command, dir);

    assert.notEqual(fp1, fp2);

    rmSync(dir, { recursive: true, force: true });
  });

  it("changes when codegen inputs change", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    writeFileSync(join(dir, "package.json"), '{"name":"test"}');
    writeFileSync(join(dir, "codegen.yml"), "schema: schema.graphql");
    writeFileSync(join(dir, "schema.graphql"), "type Query { hello: String }");

    const fp1 = computeFingerprint("pnpm run codegen", dir);

    writeFileSync(join(dir, "schema.graphql"), "type Query { hello: String, world: String }");
    const fp2 = computeFingerprint("pnpm run codegen", dir);

    assert.notEqual(fp1, fp2);

    rmSync(dir, { recursive: true });
  });

  it("changes when subdir codegen inputs change", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-"));
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name":"root"}');
    writeFileSync(join(dir, "packages", "web", "package.json"), '{"name":"web"}');
    writeFileSync(
      join(dir, "packages", "web", "codegen.yml"),
      "schema: schema.graphql",
    );
    writeFileSync(
      join(dir, "packages", "web", "schema.graphql"),
      "type Query { hello: String }",
    );

    const command = "cd packages/web && pnpm run codegen";
    const fp1 = computeFingerprint(command, dir);

    writeFileSync(
      join(dir, "packages", "web", "schema.graphql"),
      "type Query { hello: String, world: String }",
    );
    const fp2 = computeFingerprint(command, dir);

    assert.notEqual(fp1, fp2);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("shouldSkipHook / recordHookSuccess", () => {
  let cwd: string;
  let cacheDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "ao-cache-cwd-"));
    cacheDir = mkdtempSync(join(tmpdir(), "ao-cache-dir-"));
    writeFileSync(join(cwd, "package.json"), '{"name":"test"}');
    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("does not skip when no cache exists", () => {
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), false);
  });

  it("skips after a successful run with same fingerprint", () => {
    recordHookSuccess("pnpm install", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);
  });

  it("does not skip after dependency file changes", () => {
    recordHookSuccess("pnpm install", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);

    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\nnew-dep: 2.0");
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), false);
  });

  it("never skips unknown commands", () => {
    recordHookSuccess("echo hello", cwd, cacheDir);
    assert.equal(shouldSkipHook("echo hello", cwd, cacheDir), false);
  });

  it("invalidateHookCache clears all cached entries", () => {
    recordHookSuccess("pnpm install", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);

    invalidateHookCache(cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), false);
  });

  it("handles corrupted cache files gracefully", () => {
    const key = createHash("sha256").update(`pnpm install:${cwd}`).digest("hex");
    writeFileSync(join(cacheDir, `${key}.json`), "NOT VALID JSON");

    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), false);
  });

  it("isolates cache entries per command", () => {
    writeFileSync(join(cwd, "package-lock.json"), "{}");

    recordHookSuccess("pnpm install", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);
    assert.equal(shouldSkipHook("npm install", cwd, cacheDir), false);
  });

  it("isolates cache entries per cwd", () => {
    const cwd2 = mkdtempSync(join(tmpdir(), "ao-cache-cwd2-"));
    writeFileSync(join(cwd2, "package.json"), '{"name":"other"}');
    writeFileSync(join(cwd2, "pnpm-lock.yaml"), "lockfileVersion: 9");

    recordHookSuccess("pnpm install", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);
    assert.equal(shouldSkipHook("pnpm install", cwd2, cacheDir), false);

    rmSync(cwd2, { recursive: true, force: true });
  });

  it("creates cacheDir recursively if it does not exist", () => {
    const nested = join(cacheDir, "sub", "dir");
    assert.equal(existsSync(nested), false);

    recordHookSuccess("pnpm install", cwd, nested);
    assert.equal(existsSync(nested), true);
    assert.equal(shouldSkipHook("pnpm install", cwd, nested), true);
  });

  it("recordHookSuccess is a no-op for unknown commands", () => {
    recordHookSuccess("echo hello", cwd, cacheDir);
    const files = readdirSync(cacheDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 0);
  });

  it("handles multiple install hooks cached simultaneously", () => {
    writeFileSync(join(cwd, "package-lock.json"), "{}");
    writeFileSync(join(cwd, "yarn.lock"), "");

    recordHookSuccess("pnpm install", cwd, cacheDir);
    recordHookSuccess("npm ci", cwd, cacheDir);
    recordHookSuccess("yarn install", cwd, cacheDir);

    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);
    assert.equal(shouldSkipHook("npm ci", cwd, cacheDir), true);
    assert.equal(shouldSkipHook("yarn install", cwd, cacheDir), true);
  });

  it("re-records cache after dependency change", () => {
    recordHookSuccess("pnpm install", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);

    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 10");
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), false);

    recordHookSuccess("pnpm install", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm install", cwd, cacheDir), true);
  });

  it("skips cached codegen hooks until an input file changes", () => {
    writeFileSync(join(cwd, "codegen.yml"), "schema: schema.graphql");
    writeFileSync(join(cwd, "schema.graphql"), "type Query { hello: String }");

    recordHookSuccess("pnpm run codegen", cwd, cacheDir);
    assert.equal(shouldSkipHook("pnpm run codegen", cwd, cacheDir), true);

    writeFileSync(join(cwd, "schema.graphql"), "type Query { hello: String, world: String }");
    assert.equal(shouldSkipHook("pnpm run codegen", cwd, cacheDir), false);
  });

  it("skips cached chained install commands until dependencies change", () => {
    recordHookSuccess("cd . && CI=1 pnpm install --frozen-lockfile", cwd, cacheDir);
    assert.equal(
      shouldSkipHook("cd . && CI=1 pnpm install --frozen-lockfile", cwd, cacheDir),
      true,
    );

    writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: 9\nnew-dep: 3.0");
    assert.equal(
      shouldSkipHook("cd . && CI=1 pnpm install --frozen-lockfile", cwd, cacheDir),
      false,
    );
  });

  it("does not skip subdir install hooks after subdir dependencies change", () => {
    mkdirSync(join(cwd, "packages", "api"), { recursive: true });
    writeFileSync(join(cwd, "packages", "api", "package.json"), '{"name":"api"}');
    writeFileSync(
      join(cwd, "packages", "api", "pnpm-lock.yaml"),
      "api-lockfile-v1",
    );

    const command = "cd packages/api && pnpm install --frozen-lockfile";
    recordHookSuccess(command, cwd, cacheDir);
    assert.equal(shouldSkipHook(command, cwd, cacheDir), true);

    writeFileSync(
      join(cwd, "packages", "api", "pnpm-lock.yaml"),
      "api-lockfile-v2",
    );
    assert.equal(shouldSkipHook(command, cwd, cacheDir), false);
  });

  it("does not skip subdir codegen hooks after subdir inputs change", () => {
    mkdirSync(join(cwd, "packages", "web"), { recursive: true });
    writeFileSync(join(cwd, "packages", "web", "package.json"), '{"name":"web"}');
    writeFileSync(
      join(cwd, "packages", "web", "codegen.yml"),
      "schema: schema.graphql",
    );
    writeFileSync(
      join(cwd, "packages", "web", "schema.graphql"),
      "type Query { hello: String }",
    );

    const command = "cd packages/web && pnpm run codegen";
    recordHookSuccess(command, cwd, cacheDir);
    assert.equal(shouldSkipHook(command, cwd, cacheDir), true);

    writeFileSync(
      join(cwd, "packages", "web", "schema.graphql"),
      "type Query { hello: String, world: String }",
    );
    assert.equal(shouldSkipHook(command, cwd, cacheDir), false);
  });
});

describe("invalidateHookCache edge cases", () => {
  it("does not throw on non-existent directory", () => {
    const missing = join(tmpdir(), "ao-cache-nonexistent-" + Date.now());
    assert.doesNotThrow(() => invalidateHookCache(missing));
  });

  it("preserves non-json files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-cache-inv-"));
    writeFileSync(join(dir, "keep.txt"), "data");
    writeFileSync(join(dir, "remove.json"), "{}");

    invalidateHookCache(dir);

    assert.equal(existsSync(join(dir, "keep.txt")), true);
    assert.equal(existsSync(join(dir, "remove.json")), false);

    rmSync(dir, { recursive: true, force: true });
  });
});
