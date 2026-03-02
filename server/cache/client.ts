import Redis from "ioredis";
import { REDIS_URL, REDIS_ENABLED } from "../config/runtime.js";

export function createRedisClient(): Redis | null {
  if (!REDIS_ENABLED) {
    console.log("[cache] Redis disabled via REDIS_ENABLED=false");
    return null;
  }

  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy(times: number) {
      if (times > 5) {
        console.warn("[cache] Redis max retries reached, giving up");
        return null;
      }
      return Math.min(times * 500, 5000);
    },
    lazyConnect: true,
    enableOfflineQueue: false,
    reconnectOnError: () => false,
  });

  let errorLogged = false;
  client.on("error", (err: Error) => {
    if (!errorLogged) {
      console.warn("[cache] Redis connection error:", err.message);
      errorLogged = true;
    }
  });

  client.on("connect", () => {
    errorLogged = false;
  });

  client.connect().catch((err: Error) => {
    console.warn("[cache] Redis initial connection failed:", err.message);
  });

  return client;
}
