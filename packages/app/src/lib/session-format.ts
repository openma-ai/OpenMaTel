/**
 * Formatting helpers for the layered session view.
 *
 * OpenMaTel treats `null` as "the source did not report this value". It is
 * never the same thing as zero (docs/design.md §4.5/§15), so every formatter
 * here renders an em dash for unknown input — never `0`.
 *
 * The module is deliberately pure and React-free so it can be unit-tested
 * without a DOM.
 */

import type { Signal, SignalKind } from "@openmatel/core";

/** Rendered whenever a value is unknown (`null` / `undefined`). */
export const EM_DASH = "—";

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** An integer-ish count, or an em dash when the source did not report it. */
export function formatCount(value: number | null | undefined): string {
  return isFiniteNumber(value) ? String(value) : EM_DASH;
}

/** A raw token count, or an em dash. `0` is a real value and stays `"0"`. */
export function formatTokens(value: number | null | undefined): string {
  return isFiniteNumber(value) ? String(value) : EM_DASH;
}

/** A token count shortened for chart axes: `980`, `1.2k`, `3.4m`. */
export function formatCompactTokens(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute < 1_000) return `${sign}${Math.round(absolute)}`;
  if (absolute < 1_000_000) return `${sign}${trimZero(absolute / 1_000)}k`;
  if (absolute < 1_000_000_000) return `${sign}${trimZero(absolute / 1_000_000)}m`;
  return `${sign}${trimZero(absolute / 1_000_000_000)}b`;
}

const trimZero = (value: number): string => value.toFixed(1).replace(/\.0$/, "");

/**
 * A ratio in `0..1` as a percentage. `null` stays `—`, and `0` becomes `0%`.
 */
export function formatPercent(value: number | null | undefined): string {
  return isFiniteNumber(value) ? `${Math.round(value * 100)}%` : EM_DASH;
}

/** A change against the previous call, e.g. `+1.2k`, `-320`, `0`, `—`. */
export function formatTokenDelta(value: number | null | undefined): string {
  if (!isFiniteNumber(value)) return EM_DASH;
  if (value === 0) return "0";
  return value > 0 ? `+${formatTokens(value)}` : `-${formatTokens(Math.abs(value))}`;
}

/**
 * Compact duration used by idle-gap dividers: `45s`, `2h 13m`, `1d 4h`.
 * `null`/negative values render as an em dash.
 */
export function formatIdleDuration(value: number | null | undefined): string {
  if (!isFiniteNumber(value) || value < 0) return EM_DASH;
  if (value < 1_000) return `${Math.round(value)}ms`;

  const totalSeconds = Math.round(value / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
  }

  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/** The label of an {@link IdleGapMarker}: `idle 2h 13m`. */
export function formatIdleGapLabel(value: number | null | undefined): string {
  const duration = formatIdleDuration(value);
  return duration === EM_DASH ? EM_DASH : `idle ${duration}`;
}

/**
 * Collapse a prompt to one readable preview line. Missing or blank prompts
 * render as an em dash, never as an empty cell that could be mistaken for 0.
 */
export function turnPromptPreview(
  prompt: string | null | undefined,
  max = 140,
): string {
  if (prompt === null || prompt === undefined) return EM_DASH;
  const flat = prompt.replace(/\s+/g, " ").trim();
  if (flat === "") return EM_DASH;
  if (max <= 0 || flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

const SIGNAL_LABELS: Record<SignalKind, string> = {
  repeated_tool_failure: "repeated tool failure",
  loop: "loop",
  user_interrupt: "user interrupt",
  user_correction: "user correction",
};

/** Human label of a detected signal, with its repetition count when present. */
export function formatSignalLabel(signal: Signal): string {
  const label = SIGNAL_LABELS[signal.kind] ?? signal.kind;
  return signal.count === undefined ? label : `${label} ×${signal.count}`;
}

/** Explanation shown as the badge tooltip. */
export function formatSignalTitle(signal: Signal): string {
  const parts = [SIGNAL_LABELS[signal.kind] ?? signal.kind];
  if (signal.count !== undefined) parts.push(`${signal.count} repetition(s)`);
  if (signal.confidence !== undefined) {
    parts.push(`confidence ${formatPercent(signal.confidence)}`);
  }
  if (signal.detail !== undefined && signal.detail !== "") parts.push(signal.detail);
  return parts.join(" · ");
}
