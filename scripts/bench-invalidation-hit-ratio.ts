import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import express from "express";

import { createTasksRouter } from "../server/routes/tasks.js";
import { SCHEMA_SQL } from "../server/db/schema.js";
import { TASK_STATUSES } from "../server/domain/task-status.js";
import { invalidateTaskStatusChange } from "../server/cache/invalidation-helpers.js";
import type { CacheService, CacheStats } from "../server/cache/cache-service.js";

type BenchmarkMode = "legacy" | "targeted";

interface BenchmarkResult {
  mode: BenchmarkMode;
  requests: number;
  hits: number;
  misses: number;
  hitRatio: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  const now = Date.now();
  const statuses = ["inbox", "in_progress", "human_review"] as const;
  let taskNumber = 1;
  for (const status of statuses) {
    for (let i = 0; i < 12; i += 1) {
      db.prepare(
        `INSERT INTO tasks (
          id, title, description, status, priority, task_size, task_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'small', ?, ?, ?)`,
      ).run(
        `${status}-${i}`,
        `${status} task ${i}`,
        `${status} task ${i}`,
        status,
        5,
        `#${taskNumber}`,
        now + taskNumber,
        now + taskNumber,
      );
      taskNumber += 1;
    }
  }

  return db;
}

function createMemoryCache(): CacheService {
  const store = new Map<string, unknown>();
  let hits = 0;
  let misses = 0;

  function stats(): CacheStats {
    const total = hits + misses;
    return {
      hits,
      misses,
      get hitRatio() {
        return total > 0 ? hits / total : 0;
      },
    };
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      if (!store.has(key)) {
        misses += 1;
        return null;
      }
      hits += 1;
      return store.get(key) as T;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async del(key: string): Promise<void> {
      store.delete(key);
    },
    async invalidatePattern(pattern: string): Promise<void> {
      const prefix = pattern.replace(/\*$/, "");
      for (const key of Array.from(store.keys())) {
        if (key.startsWith(prefix)) {
          store.delete(key);
        }
      }
    },
    getStats() {
      return stats();
    },
    resetStats(): void {
      hits = 0;
      misses = 0;
    },
    get isConnected(): boolean {
      return true;
    },
  };
}

async function invalidateLegacyTaskCaches(cache: CacheService): Promise<void> {
  await cache.del("tasks:all");
  for (const status of TASK_STATUSES) {
    await cache.del(`tasks:status:${status}`);
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

async function runMode(mode: BenchmarkMode): Promise<BenchmarkResult> {
  const db = createDb();
  const cache = createMemoryCache();
  const app = express();
  app.use(express.json());
  app.use(createTasksRouter({
    db,
    ws: { broadcast() {} } as never,
    cache,
  }));

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address unavailable");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const routes = [
    "/tasks",
    "/tasks?status=inbox",
    "/tasks?status=in_progress",
    "/tasks?status=human_review",
  ];

  try {
    for (const route of routes) {
      const response = await fetch(`${baseUrl}${route}`);
      if (!response.ok) {
        throw new Error(`warmup failed for ${route}: HTTP ${response.status}`);
      }
      await response.text();
    }

    cache.resetStats();

    const latencies: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      if (mode === "legacy") {
        await invalidateLegacyTaskCaches(cache);
      } else {
        invalidateTaskStatusChange(cache, "in_progress", "inbox");
      }

      for (const route of routes) {
        const startedAt = performance.now();
        const response = await fetch(`${baseUrl}${route}`);
        if (!response.ok) {
          throw new Error(`${mode} benchmark failed for ${route}: HTTP ${response.status}`);
        }
        await response.text();
        latencies.push(performance.now() - startedAt);
      }
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    const totalMs = latencies.reduce((sum, value) => sum + value, 0);
    const stats = cache.getStats();

    return {
      mode,
      requests: latencies.length,
      hits: stats.hits,
      misses: stats.misses,
      hitRatio: stats.hitRatio,
      avgMs: totalMs / latencies.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    };
  } finally {
    db.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

async function main(): Promise<void> {
  const legacy = await runMode("legacy");
  const targeted = await runMode("targeted");

  const hitRatioImprovement = legacy.hitRatio === 0
    ? Number.POSITIVE_INFINITY
    : ((targeted.hitRatio - legacy.hitRatio) / legacy.hitRatio) * 100;
  const p95Reduction = legacy.p95Ms === 0
    ? 0
    : ((legacy.p95Ms - targeted.p95Ms) / legacy.p95Ms) * 100;

  console.log("Cache invalidation benchmark");
  console.log(JSON.stringify({
    legacy,
    targeted,
    improvement: {
      hitRatioDelta: `${formatPercent(targeted.hitRatio - legacy.hitRatio)}`,
      hitRatioRelative: Number.isFinite(hitRatioImprovement)
        ? `${hitRatioImprovement.toFixed(1)}%`
        : "inf",
      p95Reduction: `${p95Reduction.toFixed(1)}%`,
    },
  }, null, 2));

  console.log("");
  console.log(`legacy   hitRatio=${formatPercent(legacy.hitRatio)} avg=${formatMs(legacy.avgMs)} p50=${formatMs(legacy.p50Ms)} p95=${formatMs(legacy.p95Ms)}`);
  console.log(`targeted hitRatio=${formatPercent(targeted.hitRatio)} avg=${formatMs(targeted.avgMs)} p50=${formatMs(targeted.p50Ms)} p95=${formatMs(targeted.p95Ms)}`);
}

void main();
