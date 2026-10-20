/**
 * The processor chain and sink fan-out of the ingest pipeline.
 *
 * `createPipeline` subscribes one handler to the bus. The handler runs every
 * event through the processor chain (a processor that returns `null` drops
 * the event) and writes the resulting batch to every sink. A failure is
 * re-thrown so the bus redelivers the batch; sinks are idempotent by
 * `event_id`, which makes the retry safe.
 */

import type {
  AgentEvent,
  Bus,
  Processor,
  ProjectCtx,
  Sink,
  Unsubscribe,
} from "@openmatel/core";

/** Counters of one pipeline. All counters are event counts. */
export interface PipelineStats {
  /** Events accepted by {@link Pipeline.ingest}. */
  published: number;
  /** Events written successfully to every sink. */
  written: number;
  /** Events removed by a processor. */
  dropped: number;
  /**
   * Events in a batch whose processing attempt failed.
   *
   * A redelivered batch counts again, so this is a measure of failures, not
   * of distinct events.
   */
  failed: number;
  /** Events in a batch the bus gave up on and dead-lettered. */
  deadLettered: number;
}

/** Where an error happened. */
export type PipelineStage = "processor" | "sink" | "dead-letter";

/** Extra information handed to {@link PipelineOptions.onError}. */
export interface PipelineErrorContext {
  /** The batch whose processing failed. */
  batch: AgentEvent[];
  /** Which stage failed. */
  stage: PipelineStage;
}

/** Options of {@link createPipeline}. */
export interface PipelineOptions {
  /** Transport between ingest and the processor/sink stage. */
  bus: Bus;
  /** Processors, applied in order. Default: no processors. */
  processors?: Processor[];
  /** Destinations of the processed events. */
  sinks: Sink[];
  /** Project context handed to every processor. */
  ctx: ProjectCtx;
  /** Called for every failed attempt and for every dead-lettered batch. */
  onError?: (error: unknown, context: PipelineErrorContext) => void;
}

/** The assembled pipeline. */
export interface Pipeline {
  /** Publish events to the bus. Returns once they are enqueued. */
  ingest(events: AgentEvent[]): Promise<void>;
  /**
   * Wait until every published batch has been written or dead-lettered.
   *
   * This drains the bus (when it supports `drain()`) as well as the handler
   * that is currently running.
   */
  drain(): Promise<void>;
  /** Live counters of the pipeline. */
  stats: PipelineStats;
  /** Unsubscribe from the bus. The bus itself is not closed. */
  close(): void;
}

/** A bus that can report batches it gave up on. */
interface DeadLetterBus {
  onDeadLetter?: (
    handler: (batch: AgentEvent[], error: unknown) => void | Promise<void>,
  ) => Unsubscribe;
  addDeadLetterListener?: (
    handler: (batch: AgentEvent[], error: unknown) => void | Promise<void>,
  ) => Unsubscribe;
  subscribeDeadLetter?: (
    handler: (batch: AgentEvent[], error: unknown) => void | Promise<void>,
  ) => Unsubscribe;
}

const callSafely = (onError: PipelineOptions["onError"], error: unknown, context: PipelineErrorContext): void => {
  if (onError === undefined) return;
  try {
    onError(error, context);
  } catch {
    // An error reporter must not turn into the error it reports.
  }
};

/**
 * Create a pipeline around a bus.
 *
 * The bus subscription is installed immediately. The handler processes a
 * batch, writes it to all sinks and updates the {@link Pipeline.stats}
 * counters. Sink and processor failures are re-thrown so the bus sees them
 * and redelivers the batch.
 */
export function createPipeline(options: PipelineOptions): Pipeline {
  const { bus, ctx } = options;
  const processors = options.processors ?? [];
  const sinks = options.sinks;

  const stats: PipelineStats = {
    published: 0,
    written: 0,
    dropped: 0,
    failed: 0,
    deadLettered: 0,
  };

  let inFlight = 0;
  /** Batches published by this pipeline that have not settled yet. */
  let outstandingBatches = 0;
  let closed = false;
  const idleWaiters = new Set<() => void>();

  const isIdle = (): boolean => inFlight === 0 && outstandingBatches === 0;

  const notifyIfIdle = (): void => {
    if (!isIdle()) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const handle = async (batch: AgentEvent[]): Promise<void> => {
    inFlight += 1;
    try {
      const kept: AgentEvent[] = [];
      let dropped = 0;

      try {
        for (const event of batch) {
          let current: AgentEvent | null = event;
          for (const processor of processors) {
            current = await processor.process(current, ctx);
            if (current === null) break;
          }
          if (current === null) dropped += 1;
          else kept.push(current);
        }
      } catch (error) {
        stats.failed += batch.length;
        callSafely(options.onError, error, { batch, stage: "processor" });
        throw error;
      }

      try {
        if (kept.length > 0) {
          for (const sink of sinks) await sink.write(kept);
        }
      } catch (error) {
        stats.failed += batch.length;
        callSafely(options.onError, error, { batch, stage: "sink" });
        throw error;
      }

      // Commit the outcome only after the whole batch was written: a retry
      // recomputes it and must not count the same event twice.
      stats.written += kept.length;
      stats.dropped += dropped;
    } finally {
      inFlight -= 1;
      outstandingBatches = Math.max(0, outstandingBatches - 1);
      notifyIfIdle();
    }
  };

  const unsubscribe: Unsubscribe = bus.subscribe(handle);

  const deadLetterBus = bus as unknown as DeadLetterBus;
  const register =
    deadLetterBus.onDeadLetter ??
    deadLetterBus.addDeadLetterListener ??
    deadLetterBus.subscribeDeadLetter;
  let unsubscribeDeadLetter: Unsubscribe | undefined;
  if (typeof register === "function") {
    unsubscribeDeadLetter = register.call(deadLetterBus, (batch, error) => {
      stats.deadLettered += batch.length;
      callSafely(options.onError, error, { batch, stage: "dead-letter" });
    });
  }

  const busWithLifecycle = bus as unknown as {
    drain?: () => Promise<void>;
    pending?: () => number;
  };

  const waitForIdle = async (): Promise<void> => {
    while (!isIdle()) {
      await new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
      });
    }
  };

  return {
    ingest: async (events: AgentEvent[]): Promise<void> => {
      if (closed) throw new Error("pipeline is closed");
      if (!Array.isArray(events) || events.length === 0) return;
      const batch = [...events];
      outstandingBatches += 1;
      try {
        await bus.publish(batch);
        stats.published += events.length;
      } catch (error) {
        outstandingBatches = Math.max(0, outstandingBatches - 1);
        notifyIfIdle();
        throw error;
      }
    },

    drain: async (): Promise<void> => {
      for (;;) {
        if (typeof busWithLifecycle.drain === "function") {
          await busWithLifecycle.drain();
        }
        await waitForIdle();
        await Promise.resolve();

        if (!isIdle()) continue;
        if (typeof busWithLifecycle.pending === "function") {
          const pending = busWithLifecycle.pending();
          if (typeof pending === "number" && pending > 0) continue;
        }
        return;
      }
    },

    stats,

    close: (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      unsubscribeDeadLetter?.();
    },
  };
}
