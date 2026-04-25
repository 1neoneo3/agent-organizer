import type Redis from "ioredis";
import { CACHE_KEY_PREFIX } from "../config/runtime.js";

export interface CacheService {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  del(keys: string[]): Promise<void>;
  /** @deprecated Internal callers should use targeted invalidation helpers from cache/invalidation.ts */
  invalidatePattern(pattern: string): Promise<void>;
  readonly isConnected: boolean;
}

export function createCacheService(redis: Redis | null): CacheService {
  function prefixed(key: string): string {
    return `${CACHE_KEY_PREFIX}${key}`;
  }

  async function get<T>(key: string): Promise<T | null> {
    if (!redis) return null;
    try {
      const raw = await redis.get(prefixed(key));
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
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

  async function del(keyOrKeys: string | string[]): Promise<void> {
    if (!redis) return;
    try {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      if (keys.length === 0) return;
      await redis.del(...keys.map(prefixed));
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

  return {
    get,
    set,
    del,
    invalidatePattern,
    get isConnected() {
      return redis?.status === "ready";
    },
  };
}
