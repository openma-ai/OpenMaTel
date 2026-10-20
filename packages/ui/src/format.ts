/**
 * Small, dependency-free formatters shared by the components.
 *
 * `null` is "unknown" throughout OpenMaTel and is rendered as an em dash —
 * never as zero. That distinction is load-bearing (docs/design.md §4.5).
 */

const pad = (value: number): string => String(value).padStart(2, "0");

/** `YYYY-MM-DD HH:MM:SS` in local time, or `—` for an unusable value. */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** `HH:MM:SS` in local time, or `—`. */
export function formatClock(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Number of milliseconds between two ISO timestamps, when both are usable. */
export function durationBetween(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (start === null || start === undefined || end === null || end === undefined) return null;
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) return null;
  const delta = endTime - startTime;
  return delta >= 0 ? delta : null;
}

/** Render a duration; `—` for unknown values. */
export function formatDurationMs(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m${seconds}s`;
}

/** Render a token count; `0` stays `0`, missing stays `—`. */
export function formatTokens(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

/** Render a usage coverage ratio (`0..1`) as a percentage. */
export function formatCoverage(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

/** Collapse whitespace so a long command cannot break the row layout. */
export function singleLine(value: string, max = 220): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}
