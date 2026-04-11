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
  };
}

export const metrics: Metrics = emptyMetrics();

function resetMetrics(): void {
  const fresh = emptyMetrics();
  for (const key of Object.keys(fresh) as Array<keyof Metrics>) {
    metrics[key] = fresh[key];
  }
}

export function recordWsBroadcast(byteLength: number): void {
  metrics.wsBroadcasts += 1;
  metrics.wsBroadcastBytes += byteLength;
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
      ` hb=${metrics.heartbeatWrites}`
    );

    resetMetrics();
  }, intervalMs);

  timer.unref?.();

  return () => clearInterval(timer);
}
