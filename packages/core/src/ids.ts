/**
 * Deterministic identifiers.
 *
 * Every id in OpenMaTel is a pure function of the source coordinates that
 * produced it. That is what makes the pipeline at-least-once safe: a source
 * that re-reads the same file, or a bus that redelivers a batch, always
 * computes the same `event_id`, and sinks can upsert idempotently (§3.1).
 *
 * `node:crypto` is the only Node built-in this package may use.
 */

import { createHash } from "node:crypto";

/** Unit separator (U+001F): joins id parts without the risk of a collision between them. */
const UNIT_SEPARATOR = String.fromCharCode(31);

/** Number of hex characters kept from the digest. */
const HASH_LENGTH = 32;

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/**
 * Deterministic id of an event.
 *
 * @param parts - the natural key of the record, e.g. `["claude-code", session, 42]`.
 * @returns `"ev_"` followed by the first 32 hex characters of the SHA-256 of the
 *          parts joined with a unit separator.
 */
export function eventId(parts: (string | number)[]): string {
  return `ev_${sha256Hex(parts.map(String).join(UNIT_SEPARATOR)).slice(0, HASH_LENGTH)}`;
}

/**
 * Deterministic canonical session id.
 *
 * The canonical id is a hash of the source and the source's own session id, so
 * the same agent session keeps the same id no matter which source observed it.
 */
export function sessionId(source: string, sourceSessionId: string): string {
  return `ss_${sha256Hex([source, sourceSessionId].join(UNIT_SEPARATOR)).slice(0, HASH_LENGTH)}`;
}

/**
 * Deterministic canonical step id.
 *
 * @param parts - the natural key of the step, e.g. `["claude-code", session, 7]`.
 */
export function stepId(parts: (string | number)[]): string {
  return `st_${sha256Hex(parts.map(String).join(UNIT_SEPARATOR)).slice(0, HASH_LENGTH)}`;
}
