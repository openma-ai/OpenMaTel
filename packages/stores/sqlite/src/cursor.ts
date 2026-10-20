/**
 * Opaque pagination cursors.
 *
 * A cursor is the position of the last item of a page, encoded as base64url
 * JSON. It is opaque to the caller but not a secret: it holds exactly what
 * the keyset comparison needs, so a page can be resumed without keeping any
 * state in the store.
 */

/** The position of a session in the session list. */
export interface SessionCursor {
  /** The `started_at` of the last session of the previous page. */
  started_at: string;
  /** The id of the last session of the previous page. */
  session_id: string;
}

/** The position of a step in the step list. */
export interface StepCursor {
  /** The `ts` of the last step of the previous page. */
  ts: string;
  /** The id of the last step of the previous page. */
  step_id: string;
}

/** Encode a cursor as base64url JSON. */
export const encodeCursor = (value: SessionCursor | StepCursor): string =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/**
 * Decode a cursor.
 *
 * A cursor that cannot be decoded is treated like "no cursor": the caller
 * gets the first page again instead of an error.
 */
export const decodeCursor = <T extends SessionCursor | StepCursor>(
  cursor: string | undefined,
): T | null => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<T>;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as T;
  } catch {
    return null;
  }
};
