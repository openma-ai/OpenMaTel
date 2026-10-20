/**
 * Pure decisions for the live session view.
 *
 * Local sources do not always report a session as `running`: a file can still
 * be growing while its last event says `ok`, or its status can be `unknown`.
 * The UI therefore treats a session as live when:
 *
 * - its status is `running` or `unknown`, or
 * - its last event (`summary.ended_at`) is recent — within ten minutes.
 *
 * Polling additionally stops while the document is hidden. The same helper is
 * used by the Trajectory follow-tail logic, so the list and the poll agree on
 * what "live" means. Everything here is pure and has no DOM dependency; the
 * caller passes `document.visibilityState` and the current time in.
 */

/** How long after its last event a session is still considered live. */
export const LIVE_WINDOW_MS = 10 * 60 * 1_000;

/** The session detail poll interval. */
export const SESSION_POLL_INTERVAL_MS = 5_000;

/** Input of {@link looksLive}. */
export interface SessionLiveInput {
  /** `summary.status` of the session. */
  status?: string | null;
  /** Timestamp of the last event (`summary.ended_at`). */
  endedAt?: string | null;
  /** The raw `summary.ended_at` spelling, accepted for convenience. */
  ended_at?: string | null;
  /** A session summary, as an alternative to the two fields above. */
  summary?: {
    status?: string | null;
    ended_at?: string | null;
  } | null;
  /** Current epoch milliseconds; injectable for tests. */
  now?: number;
  /** Override the recency window, in milliseconds. */
  windowMs?: number;
}

const statusOf = (input: SessionLiveInput): string | null =>
  input.status ?? input.summary?.status ?? null;

const endedAtOf = (input: SessionLiveInput): string | null =>
  input.endedAt ?? input.ended_at ?? input.summary?.ended_at ?? null;

/** `true` when `endedAt` is a valid timestamp inside the recency window. */
export function hasRecentActivity(
  endedAt: string | null | undefined,
  now: number = Date.now(),
  windowMs: number = LIVE_WINDOW_MS,
): boolean {
  if (typeof endedAt !== "string" || endedAt === "") return false;
  const timestamp = Date.parse(endedAt);
  if (Number.isNaN(timestamp)) return false;
  const age = now - timestamp;
  // A slightly future timestamp (clock skew) is live as well.
  return age <= Math.max(0, windowMs);
}

/** `true` when the session looks like it may still receive events. */
export function looksLive(input: SessionLiveInput): boolean {
  const status = statusOf(input);
  if (status === "running" || status === "unknown") return true;
  return hasRecentActivity(
    endedAtOf(input),
    input.now ?? Date.now(),
    input.windowMs ?? LIVE_WINDOW_MS,
  );
}

/** Input of {@link shouldPoll}. */
export interface SessionPollInput extends SessionLiveInput {
  /** `document.visibilityState`; `hidden` stops polling. */
  visibilityState?: string | null;
}

/** `true` when the detail page should fetch another snapshot. */
export function shouldPoll(input: SessionPollInput): boolean {
  if (input.visibilityState === "hidden") return false;
  return looksLive(input);
}

/** The stable parts of a session snapshot used to detect a real change. */
export interface SessionRevision {
  /** Number of events in the snapshot. */
  eventCount: number;
  /** Id of the last event with an id, or `null`. */
  lastEventId: string | null;
  /** Timestamp of the last event (`summary.ended_at`). */
  endedAt: string | null;
  /** Session status. */
  status: string | null;
}

/** The minimal detail shape {@link sessionRevision} needs. */
export interface RevisionSource {
  summary: {
    ended_at: string | null;
    status: string;
  };
  turns: ReadonlyArray<{
    events: ReadonlyArray<{ event_id: string }>;
  }>;
}

/**
 * Build the cheap fingerprint of a session detail.
 *
 * Comparing this instead of the whole object prevents an identical 5-second
 * poll from replacing state and re-rendering the page.
 */
export function sessionRevision(value: RevisionSource): SessionRevision {
  let eventCount = 0;
  let lastEventId: string | null = null;
  for (const turn of value.turns) {
    for (const event of turn.events) {
      eventCount += 1;
      if (event.event_id !== "") lastEventId = event.event_id;
    }
  }
  return {
    eventCount,
    lastEventId,
    endedAt: value.summary.ended_at,
    status: value.summary.status ?? null,
  };
}

/** `true` when two revisions describe the same snapshot. */
export function sameSessionRevision(
  left: SessionRevision,
  right: SessionRevision,
): boolean {
  return (
    left.eventCount === right.eventCount &&
    left.lastEventId === right.lastEventId &&
    left.endedAt === right.endedAt &&
    left.status === right.status
  );
}
