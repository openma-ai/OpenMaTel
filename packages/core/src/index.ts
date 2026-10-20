/**
 * `@openmatel/core` — the domain model and the ports of OpenMaTel.
 *
 * Everything the adapters need is re-exported here:
 *
 * - `schema` — the canonical agent event schema `oma.agentobs.v1`;
 * - `ids` — deterministic event, session and step ids;
 * - `usage` — token accounting where "missing" and "0" stay apart;
 * - `llm` — context size, context deltas and cache-hit ratios per call;
 * - `signals` — heuristic turn signals (failures, loops, interruptions);
 * - `idle` — non-structural idle-gap markers;
 * - `tree` — session summaries, the segment/turn/step tree and segments;
 * - `ports` — the interfaces every adapter implements.
 *
 * The package has no runtime dependencies and performs no IO.
 */

export * from "./schema.js";
export * from "./ids.js";
export * from "./usage.js";
export * from "./llm.js";
export * from "./signals.js";
export * from "./idle.js";
export * from "./tree.js";
export * from "./ports.js";
