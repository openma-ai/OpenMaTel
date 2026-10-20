/**
 * `@openmatel/bus-inproc` — the in-process bus of the desktop tier.
 *
 * The bus is a small at-least-once transport between the stages of the
 * pipeline (§3.1, §3.5). Every subscriber gets its own queue, so a failing
 * consumer never blocks the others. A batch whose subscriber threw is
 * delivered again with exponential backoff; after {@link InprocBusOptions.maxAttempts}
 * attempts it is handed to the optional dead-letter callback.
 *
 * ```ts
 * const bus = createInprocBus({ maxAttempts: 3, retryDelayMs: 10 });
 * const unsubscribe = bus.subscribe(async (batch) => write(batch));
 * await bus.publish(events);
 * await bus.drain();
 * unsubscribe();
 * await bus.close();
 * ```
 *
 * Delivery is asynchronous and batches are not ordered: `publish` only
 * enqueues the batch. `drain()` waits until every queue — including the
 * retries that are currently backing off — has been settled.
 */

import type { AgentEvent, Bus, Unsubscribe } from "@openmatel/core";

/** A batch that could not be delivered within {@link InprocBusOptions.maxAttempts}. */
export type DeadLetterHandler = (
  batch: AgentEvent[],
  error: unknown,
) => void | Promise<void>;

/** Options of {@link createInprocBus}. */
export interface InprocBusOptions {
  /** How often one batch is delivered before it is dead-lettered. Default: 5. */
  maxAttempts?: number;
  /** Base delay of the exponential backoff, in milliseconds. Default: 50. */
  retryDelayMs?: number;
  /** Called when a batch exhausted its delivery attempts. */
  onDeadLetter?: DeadLetterHandler;
}

/** The in-process bus and its lifecycle methods. */
export interface InprocBus extends Bus {
  /** Resolve when every queued batch, including retries, has settled. */
  drain(): Promise<void>;
  /** Stop accepting work and clear every subscription. */
  close(): Promise<void>;
  /**
   * Register an additional dead-letter listener.
   *
   * The listener passed to {@link InprocBusOptions.onDeadLetter} and every
   * listener registered here are called in turn. The returned function
   * removes the listener.
   */
  onDeadLetter(handler: DeadLetterHandler): Unsubscribe;
  /** Number of batches that are queued, in flight or waiting for a retry. */
  pending(): number;
}

interface Subscription {
  handler: (batch: AgentEvent[]) => Promise<void>;
  active: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Create an in-process bus.
 *
 * Each subscriber has its own FIFO queue. Delivery order between subscribers
 * and between published batches is deliberately unspecified; consumers must
 * be idempotent, keyed by the deterministic `event_id` of every event.
 */
export function createInprocBus(options: InprocBusOptions = {}): InprocBus {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 50);

  const subscriptions = new Set<Subscription>();
  const deadLetterListeners = new Set<DeadLetterHandler>();
  const idleWaiters = new Set<() => void>();

  let closed = false;
  /** Batches that were published and have not settled yet (retries included). */
  let active = 0;

  const notifyIfIdle = (): void => {
    if (active > 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const deliverDeadLetter = async (batch: AgentEvent[], error: unknown): Promise<void> => {
    const listeners: DeadLetterHandler[] = [];
    if (options.onDeadLetter !== undefined) listeners.push(options.onDeadLetter);
    listeners.push(...deadLetterListeners);

    for (const listener of listeners) {
      try {
        await listener(batch, error);
      } catch {
        // A broken dead-letter handler must not resurrect or block the queue.
      }
    }
  };

  const deliver = async (subscription: Subscription, batch: AgentEvent[]): Promise<void> => {
    let attempts = 0;

    // `publish` only enqueues: give its caller a chance to return before the
    // subscriber starts. The queue (and `drain`) still accounts for the wait.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    while (!closed && subscription.active) {
      try {
        await subscription.handler([...batch]);
        return;
      } catch (error) {
        attempts += 1;

        if (closed || !subscription.active) return;

        if (attempts >= maxAttempts) {
          await deliverDeadLetter([...batch], error);
          return;
        }

        // Exponential backoff: retryDelayMs, 2×, 4×, …
        const delay = retryDelayMs * 2 ** (attempts - 1);
        if (delay > 0) await sleep(delay);
      }
    }
  };

  const enqueue = (subscription: Subscription, batch: AgentEvent[]): void => {
    active += 1;
    const task = (async () => {
      try {
        await deliver(subscription, batch);
      } finally {
        active -= 1;
        notifyIfIdle();
      }
    })();
    // The task handles every error itself; keep the promise observed so a
    // failure in the bookkeeping can not become an unhandled rejection.
    void task;
  };

  const bus: InprocBus = {
    publish: async (batch: AgentEvent[]): Promise<void> => {
      if (closed || !Array.isArray(batch) || batch.length === 0) return;
      const copy = [...batch];
      for (const subscription of subscriptions) {
        if (subscription.active) enqueue(subscription, copy);
      }
    },

    subscribe: (handler: (batch: AgentEvent[]) => Promise<void>): Unsubscribe => {
      if (closed) return () => {};
      const subscription: Subscription = { handler, active: true };
      subscriptions.add(subscription);
      return () => {
        subscription.active = false;
        subscriptions.delete(subscription);
      };
    },

    drain: async (): Promise<void> => {
      for (;;) {
        if (active === 0) {
          // Give a just-enqueued batch a chance to start before declaring
          // the bus idle.
          await Promise.resolve();
          if (active === 0) return;
        }
        await new Promise<void>((resolve) => {
          idleWaiters.add(resolve);
        });
      }
    },

    close: async (): Promise<void> => {
      closed = true;
      for (const subscription of subscriptions) subscription.active = false;
      subscriptions.clear();
      deadLetterListeners.clear();
      notifyIfIdle();
    },

    onDeadLetter: (handler: DeadLetterHandler): Unsubscribe => {
      deadLetterListeners.add(handler);
      return () => {
        deadLetterListeners.delete(handler);
      };
    },

    pending: (): number => active,
  };

  return bus;
}
