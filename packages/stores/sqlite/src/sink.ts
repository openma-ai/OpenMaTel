/**
 * The write side of the store.
 *
 * A write is one transaction:
 *
 * 1. every event is upserted by `event_id` (the last write wins);
 * 2. every session the batch touched gets its summary recomputed from *all*
 *    of its events and is upserted, together with its full-text row.
 *
 * Recomputing from the stored events — instead of patching counters — is what
 * makes the sink converge: a batch that arrives out of order, a batch that is
 * delivered twice and a batch that only contains half of a session all end up
 * in the same state.
 */

import type { AgentEvent, Sink } from "@openmatel/core";

import type { SqliteDatabase } from "./db.js";
import { insertEvent, refreshSessionSummary } from "./events.js";

/** What the sink needs to know about its store. */
export interface SinkContext {
  /** The database handle. */
  db: SqliteDatabase;
  /** `true` when the database has a usable FTS5 index. */
  fts: boolean;
}

/**
 * `true` when the event can be stored.
 *
 * An event without an id, a session or a timestamp cannot be addressed by the
 * query side, so it is dropped instead of poisoning the store.
 */
const isStorable = (event: AgentEvent): boolean =>
  typeof event?.event_id === "string" &&
  event.event_id !== "" &&
  typeof event.session_id === "string" &&
  event.session_id !== "" &&
  typeof event.project_id === "string" &&
  event.project_id !== "" &&
  typeof event.kind === "string" &&
  (event.kind as string) !== "" &&
  typeof event.ts === "string" &&
  event.ts !== "";

/** Create the Sink of the store. */
export const createSink = ({ db, fts }: SinkContext): Sink => ({
  id: "sqlite",
  write: async (batch: AgentEvent[]): Promise<void> => {
    if (!Array.isArray(batch) || batch.length === 0) return;

    const events = batch.filter(isStorable);
    if (events.length === 0) return;

    db.transaction(() => {
      const touched = new Set<string>();
      for (const event of events) {
        insertEvent(db, event);
        touched.add(event.session_id);
      }
      for (const session_id of touched) {
        refreshSessionSummary(db, session_id, fts);
      }
    });
  },
});
