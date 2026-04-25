import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { CacheService } from "../cache-service.js";
import { TASK_STATUSES } from "../../domain/task-status.js";
import {
  invalidateTaskListOnly,
  invalidateTaskAndAgents,
  invalidateTaskStatusChange,
  invalidateAllTasks,
} from "../invalidation-helpers.js";

function createSpyCache(): CacheService & { deletedKeys: string[] } {
  const deletedKeys: string[] = [];
  return {
    async get() { return null; },
    async set() {},
    async del(key: string) { deletedKeys.push(key); },
    async invalidatePattern() {},
    getStats() { return { hits: 0, misses: 0, get hitRatio() { return 0; } }; },
    resetStats() {},
    get isConnected() { return true; },
    deletedKeys,
  };
}

describe("invalidation-helpers", () => {
  describe("invalidateTaskListOnly", () => {
    it("does nothing when cache is undefined", () => {
      invalidateTaskListOnly(undefined);
    });

    it("deletes tasks:all and every tasks:status:<s> key", () => {
      const cache = createSpyCache();
      invalidateTaskListOnly(cache);

      assert.ok(cache.deletedKeys.includes("tasks:all"));
      for (const status of TASK_STATUSES) {
        assert.ok(
          cache.deletedKeys.includes(`tasks:status:${status}`),
          `expected tasks:status:${status} to be deleted`,
        );
      }
      assert.ok(!cache.deletedKeys.includes("agents:all"));
    });

    it("deletes exactly 1 + TASK_STATUSES.length keys", () => {
      const cache = createSpyCache();
      invalidateTaskListOnly(cache);
      assert.equal(cache.deletedKeys.length, 1 + TASK_STATUSES.length);
    });
  });

  describe("invalidateTaskAndAgents", () => {
    it("does nothing when cache is undefined", () => {
      invalidateTaskAndAgents(undefined);
    });

    it("deletes all task keys plus agents:all", () => {
      const cache = createSpyCache();
      invalidateTaskAndAgents(cache);

      assert.ok(cache.deletedKeys.includes("tasks:all"));
      assert.ok(cache.deletedKeys.includes("agents:all"));
      for (const status of TASK_STATUSES) {
        assert.ok(cache.deletedKeys.includes(`tasks:status:${status}`));
      }
    });
  });

  describe("invalidateTaskStatusChange", () => {
    it("does nothing when cache is undefined", () => {
      invalidateTaskStatusChange(undefined, "inbox", "in_progress");
    });

    it("deletes tasks:all, both status keys, and agents:all", () => {
      const cache = createSpyCache();
      invalidateTaskStatusChange(cache, "in_progress", "inbox");

      assert.ok(cache.deletedKeys.includes("tasks:all"));
      assert.ok(cache.deletedKeys.includes("tasks:status:in_progress"));
      assert.ok(cache.deletedKeys.includes("tasks:status:inbox"));
      assert.ok(cache.deletedKeys.includes("agents:all"));
    });

    it("does not duplicate when fromStatus equals toStatus", () => {
      const cache = createSpyCache();
      invalidateTaskStatusChange(cache, "inbox", "inbox");

      const inboxCount = cache.deletedKeys.filter((k) => k === "tasks:status:inbox").length;
      assert.equal(inboxCount, 1);
    });

    it("deletes exactly 4 keys for distinct statuses", () => {
      const cache = createSpyCache();
      invalidateTaskStatusChange(cache, "refinement", "human_review");
      assert.equal(cache.deletedKeys.length, 4);
    });

    it("deletes exactly 3 keys for same status", () => {
      const cache = createSpyCache();
      invalidateTaskStatusChange(cache, "inbox", "inbox");
      assert.equal(cache.deletedKeys.length, 3);
    });
  });

  describe("invalidateAllTasks", () => {
    it("does nothing when cache is undefined", () => {
      invalidateAllTasks(undefined);
    });

    it("deletes all task keys but not agents:all", () => {
      const cache = createSpyCache();
      invalidateAllTasks(cache);

      assert.ok(cache.deletedKeys.includes("tasks:all"));
      assert.ok(!cache.deletedKeys.includes("agents:all"));
    });
  });
});
