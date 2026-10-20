/**
 * Pure formatting helpers for the CLI.
 *
 * Everything here is deliberately dependency-free and deterministic in what
 * it does to a value; only `started_at` is rendered in the local time zone, as
 * the command specification asks.
 */

/** A table column alignment. */
export type Alignment = "left" | "right";

const pad = (value: number): string => String(value).padStart(2, "0");

/**
 * Format an ISO timestamp in the local time zone.
 *
 * @returns `YYYY-MM-DD HH:MM:SS`, or `—` when the value is missing/invalid.
 */
export function formatLocalTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Format an ISO timestamp as a local wall-clock time. */
export function formatLocalTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Collapse whitespace and shorten text to `max` characters.
 *
 * The result never exceeds `max`; a shortened text ends in `…`.
 */
export function truncateText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  if (max <= 0) return "";
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Render a token count.
 *
 * `null` means "the source did not report a number" and is rendered as `—`.
 * `0` is a real count and is rendered as `0`.
 */
export function formatTokens(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

/** Render a usage coverage ratio (`0..1`) as a percentage. */
export function formatCoverage(coverage: number | null | undefined): string {
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) return "—";
  return `${Math.round(coverage * 100)}%`;
}

/** Render a duration in milliseconds. */
export function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m${seconds}s`;
}

/** Duration between two ISO timestamps, when both are usable. */
export function durationBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const delta = Date.parse(end) - Date.parse(start);
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

/** The short form of a session id: its first twelve characters. */
export function shortSessionId(sessionId: string | null | undefined): string {
  return sessionId ? sessionId.slice(0, 12) : "—";
}

/** Render a nullable text value, using `—` for "missing". */
export function display(value: string | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : value;
}

/**
 * Render an aligned text table.
 *
 * No box drawing and no dependency: just padded columns separated by two
 * spaces, with an underline below the header.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  alignments: readonly Alignment[] = [],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)),
  );

  const renderRow = (row: readonly string[], fill: string): string =>
    row
      .map((cell, index) => {
        const width = widths[index] ?? cell.length;
        const value = cell ?? "";
        return alignments[index] === "right" ? value.padStart(width, fill) : value.padEnd(width, fill);
      })
      .join("  ")
      .trimEnd();

  const header = renderRow(headers, " ");
  const underline = renderRow(
    widths.map((width) => "-".repeat(width)),
    "-",
  );
  return [header, underline, ...rows.map((row) => renderRow(row, " "))].join("\n");
}
