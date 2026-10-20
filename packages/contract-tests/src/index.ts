/**
 * `@openmatel/contract-tests` — the contract suites every adapter must pass.
 *
 * The package exports one function per port. Each of them registers a
 * `describe` block, so an adapter only has to call it from its own test
 * file:
 *
 * ```ts
 * import { sinkQueryContract } from "@openmatel/contract-tests";
 * import { createStore } from "./store.js";
 *
 * sinkQueryContract("sqlite", async () => createStore(":memory:"));
 * ```
 *
 * The suites are grouped by port:
 *
 * - {@link sinkQueryContract} — a store that reads and writes events;
 * - {@link normalizerContract} — a normalizer that turns raw records into
 *   canonical events;
 * - {@link busContract} — a bus that transports batches of events;
 * - {@link pullSourceContract} — a source that reads local files.
 */

export * from "./fixtures.js";
export * from "./sink-query.js";
export * from "./normalizer.js";
export * from "./bus.js";
export * from "./pull-source.js";
export * from "./memory.js";
