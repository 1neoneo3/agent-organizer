import type Redis from "ioredis";
import { CACHE_KEY_PREFIX } from "../config/runtime.js";

export interface CacheStats {
  hits: number;
  misses: number;
  get hitRatio(): number;
}

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  invalidatePattern(pattern: string): Promise<void>;
  getStats(): CacheStats;
  resetStats(): void;
  readonly isConnected: boolean;
}

export function createCacheService(redis: Redis | null): CacheService {
  let hits = 0;
  let misses = 0;

  function prefixed(key: string): string {
    return `${CACHE_KEY_PREFIX}${key}`;
  }

  async function get<T>(key: string): Promise<T | null> {
    if (!redis) { misses += 1; return null; }
    try {
      const raw = await redis.get(prefixed(key));
      if (raw === null) { misses += 1; return null; }
      hits += 1;
      return JSON.parse(raw) as T;
    } catch {
      misses += 1;
      return null;
    }
  }

  async function set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!redis) return;
    try {
      await redis.set(prefixed(key), JSON.stringify(value), "EX", ttlSeconds);
    } catch {
      // DB is source of truth — silently degrade
    }
  }

  async function del(key: string): Promise<void> {
    if (!redis) return;
    try {
      await redis.del(prefixed(key));
    } catch {
      // silently degrade
    }
  }

  async function invalidatePattern(pattern: string): Promise<void> {
    if (!redis) return;
    try {
      const keys = await redis.keys(prefixed(pattern));
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {
      // silently degrade
    }
  }

  function getStats(): CacheStats {
    const total = hits + misses;
    return {
      hits,
      misses,
      get hitRatio() { return total > 0 ? hits / total : 0; },
    };
  }

  function resetStats(): void {
    hits = 0;
    misses = 0;
  }

  return {
    get,
    set,
    del,
    invalidatePattern,
    getStats,
    resetStats,
    get isConnected() {
      return redis?.status === "ready";
    },
  };
}
