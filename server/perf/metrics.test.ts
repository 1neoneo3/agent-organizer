import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  metrics,
  recordWsBroadcast,
  recordReadApi,
  recordDbLogInsertMs,
  recordStdoutChunkMs,
  recordHeartbeatWrite,
  isPerfLogEnabled,
  startPerfReporter,
} from "./metrics.js";

function resetAllMetrics(): void {
  metrics.wsBroadcasts = 0;
  metrics.wsBroadcastBytes = 0;
  metrics.dbLogInserts = 0;
  metrics.dbLogInsertTotalMs = 0;
  metrics.dbLogInsertSlow = 0;
  metrics.dbLogInsertMaxMs = 0;
  metrics.stdoutChunks = 0;
  metrics.stdoutChunkTotalMs = 0;
  metrics.stdoutChunkSlow = 0;
  metrics.stdoutChunkMaxMs = 0;
  metrics.heartbeatWrites = 0;
  for (const key of Object.keys(metrics.readApi)) delete metrics.readApi[key];
  for (const key of Object.keys(metrics.wsEventTypes)) delete metrics.wsEventTypes[key];
}

describe("metrics", () => {
  beforeEach(() => {
    resetAllMetrics();
  });

  describe("recordWsBroadcast", () => {
    it("increments broadcast count and bytes", () => {
      recordWsBroadcast(1024);
      assert.equal(metrics.wsBroadcasts, 1);
      assert.equal(metrics.wsBroadcastBytes, 1024);
    });

    it("accumulates across multiple calls", () => {
      recordWsBroadcast(100);
      recordWsBroadcast(200);
      recordWsBroadcast(300);
      assert.equal(metrics.wsBroadcasts, 3);
      assert.equal(metrics.wsBroadcastBytes, 600);
    });

    it("tracks event type breakdown when eventType is provided", () => {
      recordWsBroadcast(500, "log");
      recordWsBroadcast(300, "log");
      recordWsBroadcast(100, "status");

      assert.equal(metrics.wsEventTypes["log"].count, 2);
      assert.equal(metrics.wsEventTypes["log"].bytes, 800);
      assert.equal(metrics.wsEventTypes["status"].count, 1);
      assert.equal(metrics.wsEventTypes["status"].bytes, 100);
    });

    it("does not create event type entry when eventType is omitted", () => {
      recordWsBroadcast(500);
      assert.deepEqual(Object.keys(metrics.wsEventTypes), []);
    });

    it("does not create event type entry when eventType is empty string", () => {
      recordWsBroadcast(500, "");
      assert.deepEqual(Object.keys(metrics.wsEventTypes), []);
    });
  });

  describe("recordReadApi", () => {
    it("creates stats for a new route", () => {
      recordReadApi("tasks", 10, 2048);
      const stats = metrics.readApi["tasks"];
      assert.equal(stats.count, 1);
      assert.equal(stats.totalMs, 10);
      assert.equal(stats.maxMs, 10);
      assert.equal(stats.totalBytes, 2048);
      assert.equal(stats.slow, 0);
    });

    it("accumulates stats for repeated calls to the same route", () => {
      recordReadApi("tasks", 10, 1000);
      recordReadApi("tasks", 20, 2000);
      recordReadApi("tasks", 30, 3000);
      const stats = metrics.readApi["tasks"];
      assert.equal(stats.count, 3);
      assert.equal(stats.totalMs, 60);
      assert.equal(stats.maxMs, 30);
      assert.equal(stats.totalBytes, 6000);
    });

    it("tracks multiple routes independently", () => {
      recordReadApi("tasks", 5, 100);
      recordReadApi("logs", 15, 200);
      assert.equal(metrics.readApi["tasks"].count, 1);
      assert.equal(metrics.readApi["logs"].count, 1);
      assert.equal(metrics.readApi["tasks"].totalMs, 5);
      assert.equal(metrics.readApi["logs"].totalMs, 15);
    });

    it("marks requests exceeding 50ms as slow", () => {
      recordReadApi("tasks", 49, 100);
      assert.equal(metrics.readApi["tasks"].slow, 0);

      recordReadApi("tasks", 50, 100);
      assert.equal(metrics.readApi["tasks"].slow, 0, "exactly 50ms should not be slow");

      recordReadApi("tasks", 51, 100);
      assert.equal(metrics.readApi["tasks"].slow, 1);

      recordReadApi("tasks", 200, 100);
      assert.equal(metrics.readApi["tasks"].slow, 2);
    });

    it("updates maxMs only when a higher value arrives", () => {
      recordReadApi("tasks", 30, 100);
      assert.equal(metrics.readApi["tasks"].maxMs, 30);
      recordReadApi("tasks", 10, 100);
      assert.equal(metrics.readApi["tasks"].maxMs, 30);
      recordReadApi("tasks", 50, 100);
      assert.equal(metrics.readApi["tasks"].maxMs, 50);
    });
  });

  describe("recordDbLogInsertMs", () => {
    it("increments count and totalMs", () => {
      recordDbLogInsertMs(5);
      assert.equal(metrics.dbLogInserts, 1);
      assert.equal(metrics.dbLogInsertTotalMs, 5);
    });

    it("tracks maxMs correctly", () => {
      recordDbLogInsertMs(3);
      recordDbLogInsertMs(8);
      recordDbLogInsertMs(2);
      assert.equal(metrics.dbLogInsertMaxMs, 8);
    });

    it("marks inserts exceeding 10ms as slow", () => {
      recordDbLogInsertMs(10);
      assert.equal(metrics.dbLogInsertSlow, 0, "exactly 10ms should not be slow");

      recordDbLogInsertMs(11);
      assert.equal(metrics.dbLogInsertSlow, 1);

      recordDbLogInsertMs(100);
      assert.equal(metrics.dbLogInsertSlow, 2);
    });
  });

  describe("recordStdoutChunkMs", () => {
    it("increments count and totalMs", () => {
      recordStdoutChunkMs(2);
      assert.equal(metrics.stdoutChunks, 1);
      assert.equal(metrics.stdoutChunkTotalMs, 2);
    });

    it("tracks maxMs correctly", () => {
      recordStdoutChunkMs(1);
      recordStdoutChunkMs(4);
      recordStdoutChunkMs(2);
      assert.equal(metrics.stdoutChunkMaxMs, 4);
    });

    it("marks chunks exceeding 5ms as slow", () => {
      recordStdoutChunkMs(5);
      assert.equal(metrics.stdoutChunkSlow, 0, "exactly 5ms should not be slow");

      recordStdoutChunkMs(6);
      assert.equal(metrics.stdoutChunkSlow, 1);
    });
  });

  describe("recordHeartbeatWrite", () => {
    it("increments counter", () => {
      recordHeartbeatWrite();
      recordHeartbeatWrite();
      recordHeartbeatWrite();
      assert.equal(metrics.heartbeatWrites, 3);
    });
  });

  describe("isPerfLogEnabled", () => {
    const originalEnv = process.env.AO_PERF_LOG;
    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.AO_PERF_LOG;
      } else {
        process.env.AO_PERF_LOG = originalEnv;
      }
    });

    it("returns true when AO_PERF_LOG=1", () => {
      process.env.AO_PERF_LOG = "1";
      assert.equal(isPerfLogEnabled(), true);
    });

    it("returns false when AO_PERF_LOG is unset", () => {
      delete process.env.AO_PERF_LOG;
      assert.equal(isPerfLogEnabled(), false);
    });

    it("returns false for other values", () => {
      process.env.AO_PERF_LOG = "0";
      assert.equal(isPerfLogEnabled(), false);
      process.env.AO_PERF_LOG = "true";
      assert.equal(isPerfLogEnabled(), false);
    });
  });

  describe("startPerfReporter", () => {
    it("returns a disposer function", () => {
      const dispose = startPerfReporter(60_000);
      assert.equal(typeof dispose, "function");
      dispose();
    });

    it("resets metrics after each report", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      recordWsBroadcast(1024, "log");
      recordReadApi("tasks", 30, 500);
      recordDbLogInsertMs(5);
      recordStdoutChunkMs(3);
      recordHeartbeatWrite();

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(5_000);

      t.mock.timers.tick(5_000);

      assert.equal(logMock.mock.callCount(), 1);

      assert.equal(metrics.wsBroadcasts, 0);
      assert.equal(metrics.wsBroadcastBytes, 0);
      assert.equal(metrics.dbLogInserts, 0);
      assert.equal(metrics.heartbeatWrites, 0);
      assert.deepEqual(metrics.readApi, {});
      assert.deepEqual(metrics.wsEventTypes, {});

      dispose();
      logMock.mock.restore();
    });

    it("logs a line containing all metric sections", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      recordWsBroadcast(2048, "cli_output");
      recordReadApi("tasks", 25, 4096);
      recordDbLogInsertMs(7);
      recordStdoutChunkMs(3);
      recordHeartbeatWrite();

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(5_000);

      t.mock.timers.tick(5_000);

      const output = logMock.mock.calls[0].arguments[0] as string;
      assert.ok(output.startsWith("[perf]"), "should start with [perf]");
      assert.ok(output.includes("ws=1/"), "should contain ws broadcast count");
      assert.ok(output.includes("dbIns=1"), "should contain db insert count");
      assert.ok(output.includes("stdoutChunks=1"), "should contain stdout chunk count");
      assert.ok(output.includes("hb=1"), "should contain heartbeat count");
      assert.ok(output.includes("read=["), "should contain read API section");
      assert.ok(output.includes("tasks="), "should contain tasks route");
      assert.ok(output.includes("wsTypes=["), "should contain ws event types section");
      assert.ok(output.includes("cli_output="), "should contain cli_output event type");

      dispose();
      logMock.mock.restore();
    });

    it("omits read and wsTypes sections when empty", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      recordWsBroadcast(100);

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(5_000);

      t.mock.timers.tick(5_000);

      const output = logMock.mock.calls[0].arguments[0] as string;
      assert.ok(!output.includes("read=["), "should not contain read section");
      assert.ok(!output.includes("wsTypes=["), "should not contain wsTypes section");

      dispose();
      logMock.mock.restore();
    });

    it("sorts wsEventTypes by bytes descending", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      recordWsBroadcast(100, "status");
      recordWsBroadcast(5000, "log");
      recordWsBroadcast(500, "task_update");

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(5_000);

      t.mock.timers.tick(5_000);

      const output = logMock.mock.calls[0].arguments[0] as string;
      const wsTypesMatch = output.match(/wsTypes=\[(.+?)\]/);
      assert.ok(wsTypesMatch, "should have wsTypes section");
      const types = wsTypesMatch![1].split(", ").map((s) => s.split("=")[0]);
      assert.deepEqual(types, ["log", "task_update", "status"]);

      dispose();
      logMock.mock.restore();
    });

    it("reports zero averages when no events recorded", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(5_000);

      t.mock.timers.tick(5_000);

      const output = logMock.mock.calls[0].arguments[0] as string;
      assert.ok(output.includes("avg 0.00ms"), "db average should be 0.00ms");
      assert.ok(output.includes("ws=0/0.0KB"), "ws should be 0");

      dispose();
      logMock.mock.restore();
    });

    it("fires repeatedly at the configured interval", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(1_000);

      t.mock.timers.tick(3_000);
      assert.equal(logMock.mock.callCount(), 3);

      dispose();
      logMock.mock.restore();
    });

    it("stops reporting after dispose is called", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(1_000);

      t.mock.timers.tick(2_000);
      assert.equal(logMock.mock.callCount(), 2);

      dispose();
      t.mock.timers.tick(3_000);
      assert.equal(logMock.mock.callCount(), 2, "should not log after dispose");

      logMock.mock.restore();
    });
  });

  describe("read API formatting", () => {
    it("formats slow count only when present", (t) => {
      t.mock.timers.enable({ apis: ["setInterval"] });

      recordReadApi("tasks", 100, 1024);
      recordReadApi("logs", 5, 512);

      const logMock = t.mock.method(console, "log");
      const dispose = startPerfReporter(5_000);

      t.mock.timers.tick(5_000);

      const output = logMock.mock.calls[0].arguments[0] as string;
      assert.ok(output.includes("slow1"), "tasks should show slow count");
      assert.ok(!output.includes("logs=1x avg5.0ms max5.0ms 0.5KB slow"), "logs should not show slow");

      dispose();
      logMock.mock.restore();
    });
  });

  describe("edge cases", () => {
    it("handles zero-byte broadcasts", () => {
      recordWsBroadcast(0, "keepalive");
      assert.equal(metrics.wsBroadcasts, 1);
      assert.equal(metrics.wsBroadcastBytes, 0);
      assert.equal(metrics.wsEventTypes["keepalive"].bytes, 0);
    });

    it("handles zero-ms API responses", () => {
      recordReadApi("tasks", 0, 0);
      assert.equal(metrics.readApi["tasks"].count, 1);
      assert.equal(metrics.readApi["tasks"].totalMs, 0);
      assert.equal(metrics.readApi["tasks"].maxMs, 0);
    });

    it("handles high-volume recording without error", () => {
      for (let i = 0; i < 10_000; i++) {
        recordWsBroadcast(100, `type_${i % 10}`);
        recordReadApi(`route_${i % 5}`, i * 0.01, 100);
        recordDbLogInsertMs(i * 0.001);
        recordStdoutChunkMs(i * 0.001);
        recordHeartbeatWrite();
      }
      assert.equal(metrics.wsBroadcasts, 10_000);
      assert.equal(metrics.heartbeatWrites, 10_000);
      assert.equal(Object.keys(metrics.wsEventTypes).length, 10);
      assert.equal(Object.keys(metrics.readApi).length, 5);
    });
  });
});
