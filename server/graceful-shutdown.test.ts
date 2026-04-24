import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLogDrainShutdownHandler } from "./graceful-shutdown.js";

describe("createLogDrainShutdownHandler", () => {
  it("does not exit immediately when shutdown flush fails and retries until drained", () => {
    const shutdownAttempts: boolean[] = [false, true];
    const exitCodes: number[] = [];
    const logs: string[] = [];
    const firstSignals: NodeJS.Signals[] = [];
    const timers: Array<() => void> = [];

    const handler = createLogDrainShutdownHandler({
      shutdownLogWriter: () => shutdownAttempts.shift() ?? true,
      exit: (code) => {
        exitCodes.push(code);
      },
      log: {
        error: (message: string) => {
          logs.push(message);
        },
        info: (message: string) => {
          logs.push(message);
        },
      },
      retryDelayMs: 25,
      onFirstSignal: (signal) => {
        firstSignals.push(signal);
      },
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return {
          unref() {},
        } as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });

    handler("SIGTERM");

    assert.deepEqual(firstSignals, ["SIGTERM"]);
    assert.deepEqual(exitCodes, []);
    assert.equal(timers.length, 1);
    assert.equal(
      logs.some((message) => message.includes("keeping process alive and retrying until the in-memory queue drains")),
      true,
    );

    timers[0]();

    assert.deepEqual(exitCodes, [0]);
  });

  it("ignores repeated signals while a drain retry is already pending", () => {
    const exitCodes: number[] = [];
    const logs: string[] = [];
    const timers: Array<() => void> = [];

    const handler = createLogDrainShutdownHandler({
      shutdownLogWriter: () => false,
      exit: (code) => {
        exitCodes.push(code);
      },
      log: {
        error: (message: string) => {
          logs.push(message);
        },
        info: (message: string) => {
          logs.push(message);
        },
      },
      retryDelayMs: 25,
      setTimeoutFn: (callback) => {
        timers.push(callback);
        return {
          unref() {},
        } as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {},
    });

    handler("SIGINT");
    handler("SIGTERM");

    assert.deepEqual(exitCodes, []);
    assert.equal(timers.length, 1);
    assert.equal(
      logs.some((message) => message.includes("shutdown already in progress")),
      true,
    );
  });
});
