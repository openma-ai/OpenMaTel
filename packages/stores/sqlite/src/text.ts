/**
 * Full-text search helpers.
 *
 * The store searches sessions with FTS5 when the SQLite build supports it and
 * falls back to `LIKE` when it does not. Both paths need the same two things:
 * a literal `LIKE` pattern and an FTS5 query that cannot break on user input.
 */

/**
 * Escape the characters that are special in a `LIKE` pattern.
 *
 * The store always pairs the result with `ESCAPE '\'`.
 */
export const escapeLike = (needle: string): string =>
  needle.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * Build a `LIKE` pattern that matches the needle anywhere in the text.
 *
 * SQLite's `LIKE` is case-insensitive for ASCII, which is what a free-text
 * search is expected to do.
 */
export const likePattern = (needle: string): string => `%${escapeLike(needle)}%`;

/**
 * Build an FTS5 query for the needle as a phrase.
 *
 * The needle is wrapped in a quoted phrase, so it is matched literally. Every
 * quote of the needle is doubled, which is the FTS5 way of escaping a quote
 * inside a string — user input can therefore never produce a malformed
 * query.
 */
export const ftsPhrase = (needle: string): string => `"${needle.replace(/"/g, '""')}"`;

/**
 * Build an FTS5 query for the needle as a prefix phrase.
 *
 * `"fix"*` matches every text that starts with the word "fix". It is the
 * query of the default tokenizer, which does not know about substrings.
 */
export const ftsPrefixPhrase = (needle: string): string => `${ftsPhrase(needle)}*`;
