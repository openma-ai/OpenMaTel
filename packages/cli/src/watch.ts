/**
 * Periodic incremental indexing while `openmatel serve` is running.
 *
 * A watch pass runs the normal `index` path again. The file cursors of the
 * store (`size:mtimeMs`) make the pass cheap: discovery still walks the source
 * directories, but only files that changed are read, normalized and ingested.
 * The deterministic event ids make re-reading an appended file idempotent.
 *
 * Two rules matter here:
 *
 * - **One pass at a time.** A timer tick that arrives while a pass is still
 *   running joins the running pass instead of starting another one. The next
 *   tick is only scheduled after the current pass settled.
 * - **Errors are logged once.** A failing file must not print the same error
 *   every three seconds, and a failure must never take the server down.
 */

import { err, processIO, type CommandIO } from "./io.js";

/** Default delay between two incremental index passes. */
export const DEFAULT_WATCH_INTERVAL_MS = 3_000;

/** Options of {@link startIndexWatch}. */
export interface IndexWatchOptions {
  /**
   * Milliseconds between passes. `0` disables the timer; {@link
   * IndexWatchHandle.runOnce} can still be used for a manual pass.
   */
  intervalMs: number;
  /** One incremental index pass. */
  run: () => Promise<unknown>;
  /** Called at most once per distinct watch error. */
  onError?: (error: unknown) => void;
}

/** Handle of a running watch. */
export interface IndexWatchHandle {
  /** `true` while a pass is in flight. */
  readonly running: boolean;
  /**
   * Run one pass now. When a pass is already in flight its promise is
   * returned, so two passes can never overlap.
   */
  runOnce(): Promise<void>;
  /** Clear the timer and wait for an in-flight pass to settle. */
  stop(): Promise<void>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * Wrap the CLI output of a watch pass.
 *
 * Successful passes are silent (the initial index already printed the table).
 * Errors are forwarded the first time only; later passes that hit the same
 * error stay quiet.
 */
export function createWatchIO(io: CommandIO): CommandIO {
  const seen = new Set<string>();
  return {
    stdout: () => {},
    stderr: (text) => {
      if (seen.has(text)) return;
      seen.add(text);
      io.stderr(text);
    },
  };
}

/**
 * Start the periodic incremental index.
 *
 * The first automatic pass happens after `intervalMs`; the caller has already
 * performed the initial index. `intervalMs <= 0` starts a stopped timer but
 * keeps `runOnce` available, which is useful for tests and embedding.
 */
export function startIndexWatch(options: IndexWatchOptions): IndexWatchHandle {
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
    throw new TypeError("intervalMs must be a non-negative finite number");
  }

  const seenErrors = new Set<string>();
  const report = (error: unknown): void => {
    const key = messageOf(error);
    if (seenErrors.has(key)) return;
    seenErrors.add(key);
    try {
      if (options.onError !== undefined) {
        options.onError(error);
      } else {
        err(processIO, `error: watch: ${key}`);
      }
    } catch {
      // An error reporter must not take the server down either.
    }
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | null = null;

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    if (stopped || options.intervalMs <= 0) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      void runOnce();
    }, options.intervalMs);
    // Do not keep an embedding process alive just for the watch timer.
    timer.unref?.();
  };

  const runOnce = (): Promise<void> => {
    if (inFlight !== null) return inFlight;

    const pass: Promise<void> = Promise.resolve()
      .then(async () => {
        await options.run();
      })
      .catch((error: unknown) => {
        report(error);
      })
      .finally(() => {
        inFlight = null;
        if (!stopped) schedule();
      });

    inFlight = pass;
    return pass;
  };

  schedule();

  return {
    get running() {
      return inFlight !== null;
    },
    runOnce,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearTimer();
      const pending = inFlight;
      if (pending !== null) await pending;
    },
  };
}
