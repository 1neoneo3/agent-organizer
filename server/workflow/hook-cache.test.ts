import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach } from "node:test";
import {
  detectDependencyFiles,
  computeFingerprint,
  shouldSkipHook,
  recordHookSuccess,
  invalidateHookCache,
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
    // No package.json or pnpm-lock.yaml

    const fp = computeFingerprint("pnpm install", dir);
    assert.ok(fp);

    rmSync(dir, { recursive: true });
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
});
