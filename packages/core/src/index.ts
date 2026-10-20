/**
 * `@openmatel/core` — the domain model and the ports of OpenMaTel.
 *
 * Everything the adapters need is re-exported here:
 *
 * - `schema` — the canonical agent event schema `oma.agentobs.v1`;
 * - `ids` — deterministic event, session and step ids;
 * - `usage` — token accounting where "missing" and "0" stay apart;
 * - `tree` — session summaries and the turn/step tree;
 * - `ports` — the interfaces every adapter implements.
 *
 * The package has no runtime dependencies and performs no IO.
 */

export * from "./schema.js";
export * from "./ids.js";
export * from "./usage.js";
export * from "./tree.js";
export * from "./ports.js";
