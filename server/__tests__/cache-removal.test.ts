import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(SERVER_DIR, "..");

describe("cache layer removal", () => {
  it("server/cache/ directory does not exist", () => {
    assert.equal(
      existsSync(resolve(SERVER_DIR, "cache")),
      false,
      "server/cache/ directory should have been removed",
    );
  });

  it("ioredis is not in package.json dependencies", () => {
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8"));
    assert.equal(
      "ioredis" in (pkg.dependencies ?? {}),
      false,
      "ioredis should not be in dependencies",
    );
    assert.equal(
      "ioredis" in (pkg.devDependencies ?? {}),
      false,
      "ioredis should not be in devDependencies",
    );
  });

  it("no cache invalidation references in server source files", () => {
    const patterns = [
      "invalidateTaskCaches",
      "invalidateTaskContent",
      "invalidateTaskAndAgents",
      "invalidateTaskStatusChange",
      "invalidateAllTasks",
      "invalidatePattern",
    ];

    const hits: string[] = [];
    scanDir(SERVER_DIR, (filePath, content) => {
      if (!filePath.endsWith(".ts") || filePath.includes(".test.ts") || filePath.includes("__tests__")) return;
      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          hits.push(`${filePath}: contains '${pattern}'`);
        }
      }
    });

    assert.equal(
      hits.length,
      0,
      `Cache invalidation references found:\n${hits.join("\n")}`,
    );
  });

  it("no CacheService import in server source files", () => {
    const hits: string[] = [];
    scanDir(SERVER_DIR, (filePath, content) => {
      if (!filePath.endsWith(".ts") || filePath.includes(".test.ts") || filePath.includes("__tests__")) return;
      if (content.includes("CacheService") || content.includes("cache-service")) {
        hits.push(filePath);
      }
    });

    assert.equal(
      hits.length,
      0,
      `CacheService references found in: ${hits.join(", ")}`,
    );
  });

  it("RuntimeContext does not have a cache field", async () => {
    const runtimePath = resolve(SERVER_DIR, "types", "runtime.ts");
    const content = readFileSync(runtimePath, "utf-8");
    assert.equal(
      content.includes("cache"),
      false,
      "RuntimeContext should not contain any 'cache' field",
    );
  });

  it("server/index.ts does not reference createRedisClient or createCacheService", () => {
    const indexPath = resolve(SERVER_DIR, "index.ts");
    const content = readFileSync(indexPath, "utf-8");
    assert.equal(
      content.includes("createRedisClient"),
      false,
      "server/index.ts should not reference createRedisClient",
    );
    assert.equal(
      content.includes("createCacheService"),
      false,
      "server/index.ts should not reference createCacheService",
    );
  });

  it("server/index.ts ctx does not include cache", () => {
    const indexPath = resolve(SERVER_DIR, "index.ts");
    const content = readFileSync(indexPath, "utf-8");
    const ctxMatch = content.match(/const ctx\s*=\s*\{([^}]+)\}/);
    assert.ok(ctxMatch, "should find ctx assignment in server/index.ts");
    assert.equal(
      ctxMatch![1]!.includes("cache"),
      false,
      "ctx object should not include cache",
    );
  });
});

function scanDir(dir: string, cb: (filePath: string, content: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "__tests__") {
      scanDir(fullPath, cb);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      cb(fullPath, readFileSync(fullPath, "utf-8"));
    }
  }
}
