/**
 * Lightweight performance instrumentation for agent-organizer.
 *
 * Enabled by setting `AO_PERF_LOG=1` in the environment. When disabled,
 * the counters are still incremented (cheap) but no reporter runs and no
 * output is produced. The reporter aggregates counters once per interval
 * and logs a single line so tails stay readable.
 *
 * Design:
 *  - All counters live in a single object so call sites do not need
 *    importing many symbols.
 *  - `recordMs` wraps duration measurements for DB inserts and stdout
 *    handler chunks, bucketing "slow" events by a fixed threshold.
 *  - `startPerfReporter` returns a disposer so `server/index.ts` can
 *    keep the shutdown path clean.
 *  - No external dependencies.
 */

const SLOW_DB_INSERT_MS = 10;
const SLOW_STDOUT_CHUNK_MS = 5;
const SLOW_READ_API_MS = 50;

interface ReadApiStats {
  count: number;
  totalMs: number;
  maxMs: number;
  slow: number;
  totalBytes: number;
  maxBytes: number;
}

interface WsEventTypeStats {
  count: number;
  bytes: number;
  maxBytes: number;
}

interface Metrics {
  wsBroadcasts: number;
  wsBroadcastBytes: number;

  dbLogInserts: number;
  dbLogInsertTotalMs: number;
  dbLogInsertSlow: number;
  dbLogInsertMaxMs: number;

  stdoutChunks: number;
  stdoutChunkTotalMs: number;
  stdoutChunkSlow: number;
  stdoutChunkMaxMs: number;

  heartbeatWrites: number;

  readApi: Record<string, ReadApiStats>;
  wsEventTypes: Record<string, WsEventTypeStats>;
}

function emptyReadApiStats(): ReadApiStats {
  return { count: 0, totalMs: 0, maxMs: 0, slow: 0, totalBytes: 0, maxBytes: 0 };
}

function emptyWsEventTypeStats(): WsEventTypeStats {
  return { count: 0, bytes: 0, maxBytes: 0 };
}

function emptyMetrics(): Metrics {
  return {
    wsBroadcasts: 0,
    wsBroadcastBytes: 0,
    dbLogInserts: 0,
    dbLogInsertTotalMs: 0,
    dbLogInsertSlow: 0,
    dbLogInsertMaxMs: 0,
    stdoutChunks: 0,
    stdoutChunkTotalMs: 0,
    stdoutChunkSlow: 0,
    stdoutChunkMaxMs: 0,
    heartbeatWrites: 0,
    readApi: {},
    wsEventTypes: {},
  };
}

export const metrics: Metrics = emptyMetrics();

function resetMetrics(): void {
  const fresh = emptyMetrics();
  for (const key of Object.keys(fresh) as Array<keyof Metrics>) {
    (metrics as unknown as Record<string, unknown>)[key] = fresh[key];
  }
}

export function recordWsBroadcast(byteLength: number, eventType?: string): void {
  metrics.wsBroadcasts += 1;
  metrics.wsBroadcastBytes += byteLength;
  if (eventType) {
    const entry = metrics.wsEventTypes[eventType] ??= emptyWsEventTypeStats();
    entry.count += 1;
    entry.bytes += byteLength;
    if (byteLength > entry.maxBytes) entry.maxBytes = byteLength;
  }
}

export function recordReadApi(route: string, ms: number, payloadBytes: number): void {
  const entry = metrics.readApi[route] ??= emptyReadApiStats();
  entry.count += 1;
  entry.totalMs += ms;
  if (ms > entry.maxMs) entry.maxMs = ms;
  if (ms > SLOW_READ_API_MS) entry.slow += 1;
  entry.totalBytes += payloadBytes;
  if (payloadBytes > entry.maxBytes) entry.maxBytes = payloadBytes;
}

export function recordDbLogInsertMs(ms: number): void {
  metrics.dbLogInserts += 1;
  metrics.dbLogInsertTotalMs += ms;
  if (ms > metrics.dbLogInsertMaxMs) metrics.dbLogInsertMaxMs = ms;
  if (ms > SLOW_DB_INSERT_MS) metrics.dbLogInsertSlow += 1;
}

export function recordStdoutChunkMs(ms: number): void {
  metrics.stdoutChunks += 1;
  metrics.stdoutChunkTotalMs += ms;
  if (ms > metrics.stdoutChunkMaxMs) metrics.stdoutChunkMaxMs = ms;
  if (ms > SLOW_STDOUT_CHUNK_MS) metrics.stdoutChunkSlow += 1;
}

export function recordHeartbeatWrite(): void {
  metrics.heartbeatWrites += 1;
}

/**
 * Check whether perf logging is enabled. The reporter is only started
 * when this returns true, so instrumentation stays free when off.
 */
export function isPerfLogEnabled(): boolean {
  return process.env.AO_PERF_LOG === "1";
}

function formatReadApiLine(): string {
  const entries = Object.entries(metrics.readApi);
  if (entries.length === 0) return "";
  const parts = entries
    .sort((a, b) => {
      const totalMsDiff = b[1].totalMs - a[1].totalMs;
      if (totalMsDiff !== 0) return totalMsDiff;
      return b[1].totalBytes - a[1].totalBytes;
    })
    .map(([route, s]) => {
      const avgMs = s.count > 0 ? (s.totalMs / s.count).toFixed(1) : "0";
      const avgKb = s.count > 0 ? (s.totalBytes / s.count / 1024).toFixed(1) : "0.0";
      const maxKb = (s.maxBytes / 1024).toFixed(1);
      const totalKb = (s.totalBytes / 1024).toFixed(1);
      return `${route}=${s.count}x avg${avgMs}ms max${s.maxMs.toFixed(1)}ms payload(avg${avgKb}KB max${maxKb}KB total${totalKb}KB)${s.slow > 0 ? ` slow${s.slow}` : ""}`;
    });
  return ` read=[${parts.join(", ")}]`;
}

function formatWsEventTypeLine(): string {
  const entries = Object.entries(metrics.wsEventTypes);
  if (entries.length === 0) return "";
  const parts = entries
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([type, s]) => {
      const avgKb = s.count > 0 ? (s.bytes / s.count / 1024).toFixed(1) : "0.0";
      const maxKb = (s.maxBytes / 1024).toFixed(1);
      const totalKb = (s.bytes / 1024).toFixed(1);
      return `${type}=${s.count}x payload(avg${avgKb}KB max${maxKb}KB total${totalKb}KB)`;
    });
  return ` wsTypes=[${parts.join(", ")}]`;
}

/**
 * Start a periodic reporter that prints one aggregate line per interval
 * and then resets the counters. Returns a disposer.
 */
export function startPerfReporter(intervalMs = 5_000): () => void {
  const timer = setInterval(() => {
    const bytesKb = (metrics.wsBroadcastBytes / 1024).toFixed(1);
    const dbAvgMs = metrics.dbLogInserts > 0
      ? (metrics.dbLogInsertTotalMs / metrics.dbLogInserts).toFixed(2)
      : "0.00";
    const stdoutAvgMs = metrics.stdoutChunks > 0
      ? (metrics.stdoutChunkTotalMs / metrics.stdoutChunks).toFixed(2)
      : "0.00";

    console.log(
      `[perf] ws=${metrics.wsBroadcasts}/${bytesKb}KB` +
      ` dbIns=${metrics.dbLogInserts} (avg ${dbAvgMs}ms max ${metrics.dbLogInsertMaxMs.toFixed(1)}ms slow ${metrics.dbLogInsertSlow})` +
      ` stdoutChunks=${metrics.stdoutChunks} (avg ${stdoutAvgMs}ms max ${metrics.stdoutChunkMaxMs.toFixed(1)}ms slow ${metrics.stdoutChunkSlow})` +
      ` hb=${metrics.heartbeatWrites}` +
      formatReadApiLine() +
      formatWsEventTypeLine()
    );

    resetMetrics();
  }, intervalMs);

  timer.unref?.();

  return () => clearInterval(timer);
}
