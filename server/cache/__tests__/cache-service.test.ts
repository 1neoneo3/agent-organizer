import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createCacheService, type CacheService } from "../cache-service.js";

// Minimal mock Redis that stores data in-memory
function createMockRedis(options?: { shouldThrow?: boolean }) {
  const store = new Map<string, { value: string; expiry: number }>();
  const shouldThrow = options?.shouldThrow ?? false;

  return {
    status: "ready" as string,
    async get(key: string): Promise<string | null> {
      if (shouldThrow) throw new Error("Redis error");
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiry > 0 && Date.now() > entry.expiry) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key: string, value: string, _mode: string, ttl: number): Promise<void> {
      if (shouldThrow) throw new Error("Redis error");
      store.set(key, { value, expiry: Date.now() + ttl * 1000 });
    },
    async del(...keys: string[]): Promise<void> {
      if (shouldThrow) throw new Error("Redis error");
      for (const key of keys) {
        store.delete(key);
      }
    },
    async keys(pattern: string): Promise<string[]> {
      if (shouldThrow) throw new Error("Redis error");
      const prefix = pattern.replace("*", "");
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    _store: store,
  };
}

describe("CacheService", () => {
  describe("with null redis (disabled)", () => {
    let cache: CacheService;

    beforeEach(() => {
      cache = createCacheService(null);
    });

    it("get returns null", async () => {
      const result = await cache.get("test");
      assert.equal(result, null);
    });

    it("set does not throw", async () => {
      await cache.set("test", { hello: "world" }, 60);
    });

    it("del does not throw", async () => {
      await cache.del("test");
    });

    it("invalidatePattern does not throw", async () => {
      await cache.invalidatePattern("test:*");
    });

    it("isConnected is false", () => {
      assert.equal(cache.isConnected, false);
    });
  });

  describe("with mock redis (connected)", () => {
    let cache: CacheService;
    let mockRedis: ReturnType<typeof createMockRedis>;

    beforeEach(() => {
      mockRedis = createMockRedis();
      cache = createCacheService(mockRedis as never);
    });

    it("set then get returns the value", async () => {
      await cache.set("agents:all", [{ id: "1", name: "Agent 1" }], 60);
      const result = await cache.get<Array<{ id: string; name: string }>>("agents:all");
      assert.deepEqual(result, [{ id: "1", name: "Agent 1" }]);
    });

    it("get returns null for missing key", async () => {
      const result = await cache.get("nonexistent");
      assert.equal(result, null);
    });

    it("del removes a key", async () => {
      await cache.set("test", "value", 60);
      await cache.del("test");
      const result = await cache.get("test");
      assert.equal(result, null);
    });

    it("invalidatePattern removes matching keys", async () => {
      await cache.set("test:all", "data1", 60);
      await cache.set("test:status:inbox", "data2", 60);
      await cache.set("agents:all", "data3", 60);

      await cache.invalidatePattern("test:*");

      assert.equal(await cache.get("test:all"), null);
      assert.equal(await cache.get("test:status:inbox"), null);
      assert.equal(await cache.get("agents:all"), "data3");
    });

    it("isConnected reflects redis status", () => {
      assert.equal(cache.isConnected, true);
      mockRedis.status = "connecting";
      assert.equal(cache.isConnected, false);
    });

    it("stores complex objects via JSON serialization", async () => {
      const data = { nested: { array: [1, 2, 3], flag: true } };
      await cache.set("complex", data, 60);
      const result = await cache.get("complex");
      assert.deepEqual(result, data);
    });
  });

  describe("getStats / resetStats", () => {
    it("starts with zero hits and misses", () => {
      const mockRedis = createMockRedis();
      const c = createCacheService(mockRedis as never);
      const stats = c.getStats();
      assert.equal(stats.hits, 0);
      assert.equal(stats.misses, 0);
      assert.equal(stats.hitRatio, 0);
    });

    it("tracks hits and misses", async () => {
      const mockRedis = createMockRedis();
      const c = createCacheService(mockRedis as never);
      await c.set("key1", "value1", 60);
      await c.get("key1"); // hit
      await c.get("key1"); // hit
      await c.get("missing"); // miss
      const stats = c.getStats();
      assert.equal(stats.hits, 2);
      assert.equal(stats.misses, 1);
      assert.ok(Math.abs(stats.hitRatio - 2 / 3) < 0.001);
    });

    it("counts miss when redis is null", async () => {
      const c = createCacheService(null);
      await c.get("any");
      assert.equal(c.getStats().misses, 1);
    });

    it("resetStats clears counters", async () => {
      const mockRedis = createMockRedis();
      const c = createCacheService(mockRedis as never);
      await c.set("k", "v", 60);
      await c.get("k");
      c.resetStats();
      const stats = c.getStats();
      assert.equal(stats.hits, 0);
      assert.equal(stats.misses, 0);
    });
  });

  describe("graceful degradation (redis throws)", () => {
    let cache: CacheService;

    beforeEach(() => {
      const mockRedis = createMockRedis({ shouldThrow: true });
      cache = createCacheService(mockRedis as never);
    });

    it("get returns null without throwing", async () => {
      const result = await cache.get("test");
      assert.equal(result, null);
    });

    it("set does not throw", async () => {
      await cache.set("test", "value", 60);
    });

    it("del does not throw", async () => {
      await cache.del("test");
    });

    it("invalidatePattern does not throw", async () => {
      await cache.invalidatePattern("test:*");
    });
  });
});
