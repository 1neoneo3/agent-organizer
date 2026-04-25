import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { CacheService } from "../cache-service.js";
import { CACHE_KEYS } from "../keys.js";
import {
  invalidateTaskStatusChange,
  invalidateTaskListOnly,
  invalidateTaskAndAgents,
  invalidateAllTasks,
} from "../invalidation.js";

function createTrackingCache(): CacheService & { deleted: string[][] } {
  const deleted: string[][] = [];
  return {
    deleted,
    async get() {
      return null;
    },
    async set() {},
    async del(keyOrKeys: string | string[]) {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      deleted.push(keys);
    },
    async invalidatePattern() {},
    get isConnected() {
      return true;
    },
  };
}

describe("invalidateTaskStatusChange", () => {
  it("deletes tasks:all and both status keys in a single batch", async () => {
    const cache = createTrackingCache();
    await invalidateTaskStatusChange(cache, "inbox", "in_progress");

    assert.equal(cache.deleted.length, 1, "should be a single batch del call");
    const keys = cache.deleted[0];
    assert.ok(keys.includes(CACHE_KEYS.TASKS_ALL));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("inbox")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("in_progress")));
    assert.equal(keys.length, 3);
  });

  it("handles same old/new status (deletion case)", async () => {
    const cache = createTrackingCache();
    await invalidateTaskStatusChange(cache, "done", "done");

    assert.equal(cache.deleted.length, 1);
    const keys = cache.deleted[0];
    assert.ok(keys.includes(CACHE_KEYS.TASKS_ALL));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("done")));
  });

  it("does not include unrelated status keys", async () => {
    const cache = createTrackingCache();
    await invalidateTaskStatusChange(cache, "inbox", "refinement");

    const keys = cache.deleted[0];
    assert.ok(!keys.includes(CACHE_KEYS.tasksStatus("in_progress")));
    assert.ok(!keys.includes(CACHE_KEYS.tasksStatus("done")));
    assert.ok(!keys.includes(CACHE_KEYS.AGENTS_ALL));
  });
});

describe("invalidateTaskListOnly", () => {
  it("deletes only tasks:all", async () => {
    const cache = createTrackingCache();
    await invalidateTaskListOnly(cache);

    assert.equal(cache.deleted.length, 1);
    const keys = cache.deleted[0];
    assert.deepEqual(keys, [CACHE_KEYS.TASKS_ALL]);
  });
});

describe("invalidateTaskAndAgents", () => {
  it("with status args: deletes targeted task keys + agents:all", async () => {
    const cache = createTrackingCache();
    await invalidateTaskAndAgents(cache, "inbox", "in_progress");

    assert.equal(cache.deleted.length, 1);
    const keys = cache.deleted[0];
    assert.ok(keys.includes(CACHE_KEYS.TASKS_ALL));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("inbox")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("in_progress")));
    assert.ok(keys.includes(CACHE_KEYS.AGENTS_ALL));
    assert.equal(keys.length, 4);
  });

  it("without status args: deletes all task keys + agents:all", async () => {
    const cache = createTrackingCache();
    await invalidateTaskAndAgents(cache);

    assert.equal(cache.deleted.length, 1);
    const keys = cache.deleted[0];
    assert.ok(keys.includes(CACHE_KEYS.TASKS_ALL));
    assert.ok(keys.includes(CACHE_KEYS.AGENTS_ALL));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("inbox")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("done")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("cancelled")));
  });

  it("does not include settings:all", async () => {
    const cache = createTrackingCache();
    await invalidateTaskAndAgents(cache);

    const keys = cache.deleted[0];
    assert.ok(!keys.includes("settings:all"));
  });
});

describe("invalidateAllTasks", () => {
  it("deletes tasks:all and every status-specific key", async () => {
    const cache = createTrackingCache();
    await invalidateAllTasks(cache);

    assert.equal(cache.deleted.length, 1);
    const keys = cache.deleted[0];
    assert.ok(keys.includes(CACHE_KEYS.TASKS_ALL));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("inbox")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("refinement")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("in_progress")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("test_generation")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("qa_testing")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("pr_review")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("human_review")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("done")));
    assert.ok(keys.includes(CACHE_KEYS.tasksStatus("cancelled")));
    assert.equal(keys.length, 10);
  });

  it("does not include agents:all", async () => {
    const cache = createTrackingCache();
    await invalidateAllTasks(cache);

    const keys = cache.deleted[0];
    assert.ok(!keys.includes(CACHE_KEYS.AGENTS_ALL));
  });
});
