const DEFAULT_RETRY_DELAY_MS = 1_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface LogDrainShutdownOptions {
  shutdownLogWriter: () => boolean;
  exit: (code: number) => void;
  log?: Pick<Console, "error" | "info">;
  retryDelayMs?: number;
  onFirstSignal?: (signal: NodeJS.Signals) => void;
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
}

export function createLogDrainShutdownHandler({
  shutdownLogWriter,
  exit,
  log = console,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  onFirstSignal,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}: LogDrainShutdownOptions): (signal: NodeJS.Signals) => void {
  let shuttingDown = false;
  let activeSignal: NodeJS.Signals | null = null;
  let retryTimer: TimeoutHandle | null = null;

  const clearRetryTimer = (): void => {
    if (retryTimer === null) return;
    clearTimeoutFn(retryTimer);
    retryTimer = null;
  };

  const attemptDrain = (): void => {
    if (shutdownLogWriter()) {
      clearRetryTimer();
      exit(0);
      return;
    }

    log.error(
      `[shutdown] ${activeSignal ?? "signal"}: log flush failed; keeping process alive and retrying until the in-memory queue drains`,
    );

    if (retryTimer !== null) return;

    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      attemptDrain();
    }, retryDelayMs);
    retryTimer.unref?.();
  };

  return (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      log.info(
        `[shutdown] ${signal}: shutdown already in progress; waiting for the log queue to drain`,
      );
      return;
    }

    shuttingDown = true;
    activeSignal = signal;
    onFirstSignal?.(signal);
    attemptDrain();
  };
}
