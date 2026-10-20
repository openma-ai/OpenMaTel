/**
 * Pure geometry for the Trajectory view (GitHub #76, part 2).
 *
 * Three pieces of maths live here so the components stay thin and the hard
 * parts are testable without a DOM:
 *
 * - **Overview viewport** — wheel zoom around a cursor, right-drag pan and the
 *   screen ↔ model coordinate mapping used to draw the fixed overview strip.
 * - **Ledger layout** — fixed-height rows with optional taller inline
 *   waterfalls, prefix offsets and the visible window (with overscan) a
 *   virtualized list renders.
 * - **Scroll anchoring** — keeping the reading position when earlier rows are
 *   prepended, and deciding when a live session should follow the tail.
 *
 * Everything is a pure function. Missing values stay `null`; no value here is
 * silently turned into zero.
 */

import {
  firstRowIndexInTimeRange,
  type LedgerRow,
  type LedgerRowKind,
  type LedgerTimeRange,
} from "./ledger";
import { looksLive } from "./live";

export {
  timeRangeForRange,
  type OverviewTimeRange,
} from "./overview-timeline";

/** A closed range in normalised (`0..1`) overview coordinates. */
export interface Viewport {
  start: number;
  end: number;
}

/** The full session domain. */
export const FULL_VIEWPORT: Viewport = { start: 0, end: 1 };

/** Smallest visible fraction after repeated zooming. */
export const MIN_VIEWPORT_SPAN = 0.02;

/** Multiplier applied by one wheel notch. `< 1` zooms in. */
export const VIEWPORT_ZOOM_STEP = 0.8;

/** Default fixed ledger row height, in CSS pixels. */
export const LEDGER_ROW_HEIGHT = 28;

/** Height of a compact request separator (a one-line divider), in pixels. */
export const LEDGER_SEPARATOR_HEIGHT = 16;

/** Height of an inline per-turn waterfall row, in CSS pixels. */
export const WATERFALL_ROW_HEIGHT = 320;

/**
 * Height used by the virtualizer for one ledger row.
 *
 * Request separators are thin dividers; every other row keeps the standard
 * fixed height so the offset table stays cheap and correct.
 */
export function ledgerRowHeight(kind: LedgerRowKind): number {
  return kind === "request" ? LEDGER_SEPARATOR_HEIGHT : LEDGER_ROW_HEIGHT;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const clamp01 = (value: number): number => clamp(value, 0, 1);

/** Span of a viewport; always a positive number. */
export function viewportSpan(viewport: Viewport): number {
  return Math.max(MIN_VIEWPORT_SPAN, Math.abs(viewport.end - viewport.start));
}

/** Clamp a range into `0..1`, preserving a minimum visible span. */
export function clampViewport(
  start: number,
  end: number,
  minSpan = MIN_VIEWPORT_SPAN,
): Viewport {
  const minimum = clamp(minSpan, 0, 1);
  const span = clamp(Math.abs(end - start), minimum, 1);
  const left = clamp(Math.min(start, end), 0, 1 - span);
  return { start: left, end: left + span };
}

/** `true` when the viewport shows the whole session. */
export function isFullViewport(viewport: Viewport): boolean {
  return viewport.start <= 1e-6 && viewport.end >= 1 - 1e-6;
}

/**
 * Zoom around a cursor.
 *
 * `anchor` is the cursor position as a fraction of the track (`0..1`). The
 * model point under the cursor stays under the cursor after the zoom. A
 * negative `deltaY` (wheel up) zooms in; positive zooms out.
 */
export function zoomViewport(
  viewport: Viewport,
  anchor: number,
  deltaY: number,
  step = VIEWPORT_ZOOM_STEP,
): Viewport {
  const current = clampViewport(viewport.start, viewport.end);
  const cursor = clamp01(anchor);
  const factor = deltaY < 0 ? step : 1 / step;
  const nextSpan = clamp(viewportSpan(current) * factor, MIN_VIEWPORT_SPAN, 1);
  const modelAnchor =
    current.start + cursor * (current.end - current.start);
  const start = clamp(modelAnchor - cursor * nextSpan, 0, 1 - nextSpan);
  return { start, end: start + nextSpan };
}

/**
 * Pan by a fraction of the whole domain. Positive `delta` moves the window
 * towards later history; the span is preserved.
 */
export function panViewport(viewport: Viewport, delta: number): Viewport {
  const current = clampViewport(viewport.start, viewport.end);
  const span = viewportSpan(current);
  const start = clamp(current.start + delta, 0, 1 - span);
  return { start, end: start + span };
}

/** Map a screen fraction (`0..1`) into the normalised model domain. */
export function screenToModelFraction(viewport: Viewport, screen: number): number {
  const current = clampViewport(viewport.start, viewport.end);
  return clamp(current.start + clamp01(screen) * (current.end - current.start), 0, 1);
}

/**
 * Map a normalised model fraction into `0..1` screen coordinates.
 *
 * The result is deliberately *not* clamped: bars outside the zoomed viewport
 * must be able to render partially (the lane clips them).
 */
export function modelToScreenFraction(viewport: Viewport, model: number): number {
  const current = clampViewport(viewport.start, viewport.end);
  return (model - current.start) / viewportSpan(current);
}

/** One rendered row of the ledger's virtual list. */
export interface LedgerWindowRow {
  /** Stable React key. */
  key: string;
  /** Height in CSS pixels. */
  height: number;
}

/** Prefix offsets of a variable-height row list. */
export interface RowLayout {
  heights: number[];
  /** `offsets[i]` is the top of row `i`; the last entry is the total height. */
  offsets: number[];
  total: number;
}

/** Build the offset table used to virtualize rows of mixed heights. */
export function buildRowLayout(heights: readonly number[]): RowLayout {
  const normalized = heights.map((height) =>
    Number.isFinite(height) && height > 0 ? height : 0,
  );
  const offsets: number[] = [0];
  let total = 0;
  for (const height of normalized) {
    total += height;
    offsets.push(total);
  }
  return { heights: normalized, offsets, total };
}

/** Top offset of one row, clamped to the layout. */
export function rowOffset(layout: RowLayout, index: number): number {
  if (layout.offsets.length === 0) return 0;
  const clamped = clamp(Math.floor(index), 0, layout.heights.length);
  return layout.offsets[clamped] ?? layout.total;
}

/**
 * Visible row range (`end` exclusive) for a scroll position and viewport.
 *
 * `overscan` rows are added on each side so scrolling stays blank-free. When
 * the list is empty the range is `{ start: 0, end: 0 }`.
 */
export function findVisibleRange(
  layout: RowLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan = 6,
): { start: number; end: number } {
  const count = layout.heights.length;
  if (count === 0 || layout.total <= 0) return { start: 0, end: 0 };

  const top = clamp(Number.isFinite(scrollTop) ? scrollTop : 0, 0, layout.total);
  const height =
    Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
  const bottom = clamp(top + height, top, layout.total);

  const firstAtOrAfter = (value: number): number => {
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (layout.offsets[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  // The last row whose top is <= top.
  let start = Math.max(0, firstAtOrAfter(top) - 1);
  if (layout.offsets[start + 1]! <= top) {
    // `top` is exactly at a row boundary; start at the next row.
    start = Math.min(count - 1, start + 1);
  }

  // The first row whose top is >= bottom; the row containing `bottom` is
  // included by using that index as the exclusive end.
  let end = Math.min(count, Math.max(start, firstAtOrAfter(bottom)));
  if (end <= start) end = Math.min(count, start + 1);

  const margin = Math.max(0, Math.floor(overscan));
  return {
    start: Math.max(0, start - margin),
    end: Math.min(count, end + margin),
  };
}

/** Scroll offset that puts a row at the top of the viewport. */
export function scrollTopForRow(layout: RowLayout, index: number): number {
  return rowOffset(layout, index);
}

/**
 * New `scrollTop` after rows are prepended.
 *
 * The content that was at the top of the viewport must stay there:
 * `oldTop + (newHeight - oldHeight)` cancels the height the browser added
 * above the reading position.
 */
export function anchoredScrollTop(
  previousScrollHeight: number,
  previousScrollTop: number,
  nextScrollHeight: number,
): number {
  const delta = nextScrollHeight - previousScrollHeight;
  return Math.max(0, previousScrollTop + (Number.isFinite(delta) ? delta : 0));
}

/** `true` when the scroll position is within `threshold` of the bottom. */
export function isNearBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 24,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** Input of {@link shouldFollowTail}. */
export interface FollowTailInput {
  /** Session status, or `null` while it is still being loaded. */
  status: string | null | undefined;
  /** Timestamp of the last event (`summary.ended_at`). */
  endedAt?: string | null;
  /** Current epoch milliseconds; injectable for tests. */
  now?: number;
  /** `true` when the ledger is currently pinned at the bottom. */
  atBottom: boolean;
  /** `true` when a refresh added rows since the previous render. */
  rowsGrew: boolean;
}

/**
 * Keep a live session pinned to the bottom when the reader is already there.
 * A growing ledger always follows; a session that did not grow still follows
 * while it looks live (running/unknown, or a recent last event). A finished
 * session does not move the reader's position on an unrelated refresh.
 */
export function shouldFollowTail(input: FollowTailInput): boolean {
  if (!input.atBottom) return false;
  if (input.rowsGrew) return true;
  return looksLive({
    status: input.status,
    endedAt: input.endedAt ?? null,
    now: input.now,
  });
}

/** Normalised `0..1` range covered by a slice of ledger rows. */
export function ledgerWindowFraction(
  startIndex: number,
  endIndex: number,
  total: number,
): Viewport | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const start = clamp(Math.min(startIndex, endIndex), 0, total) / total;
  const end = clamp(Math.max(startIndex, endIndex), 0, total) / total;
  return { start, end: Math.max(start, end) };
}

/** Input of {@link windowForTarget}. */
export interface WindowForTargetInput {
  /** Number of rows in the current (filtered) ledger. */
  total: number;
  /** Current first row of the rendered window. */
  start: number;
  /** Maximum number of rows in the window. */
  size: number;
  /** Index of the row that must become visible. */
  targetIndex: number;
}

/**
 * First row of the window that reveals `targetIndex`.
 *
 * A window that already contains the target is kept as-is. Otherwise the target
 * is placed around the middle of the window, leaving context before it, and the
 * result is clamped so the window never leaves the row list. Empty lists and
 * non-positive sizes again return a clamped start without inventing rows.
 */
export function windowForTarget({
  total,
  start,
  size,
  targetIndex,
}: WindowForTargetInput): number {
  const count = Math.max(
    0,
    Math.floor(Number.isFinite(total) ? total : 0),
  );
  if (count === 0) return 0;

  const windowSize = Math.min(
    count,
    Math.max(0, Math.floor(Number.isFinite(size) ? size : 0)),
  );
  if (windowSize === 0) return 0;

  const maximumStart = Math.max(0, count - windowSize);
  const currentStart = clamp(
    Math.floor(Number.isFinite(start) ? start : 0),
    0,
    maximumStart,
  );
  const target = clamp(
    Math.floor(Number.isFinite(targetIndex) ? targetIndex : 0),
    0,
    count - 1,
  );

  if (target >= currentStart && target < currentStart + windowSize) {
    return currentStart;
  }

  const context = Math.floor(windowSize / 2);
  return clamp(target - context, 0, maximumStart);
}

/** Structural subset of an overview span needed to locate its ledger row. */
export interface OverviewSpanTarget {
  id: string;
  kind: "input" | "llm" | "tool";
  turn_id: string | null;
  /** Request number for an `llm` span, or `null`. */
  request_index: number | null;
}

const eventIdOfSpan = (id: string): string | null => {
  const colon = id.indexOf(":");
  if (colon < 0 || colon === id.length - 1) return null;
  return id.slice(colon + 1);
};

/**
 * Find the ledger row a clicked overview bar points at.
 *
 * LLM bars map to the request separator of the same turn/request; input and
 * tool bars map by the event id embedded in their span id. A turn header is
 * the fallback, so a click always has somewhere to scroll.
 */
export function rowIndexForSpan(
  rows: readonly LedgerRow[],
  span: OverviewSpanTarget,
): number {
  if (span.kind === "llm") {
    const request = rows.findIndex(
      (row) =>
        row.kind === "request" &&
        row.turn_id === span.turn_id &&
        (span.request_index === null || row.request_index === span.request_index),
    );
    if (request >= 0) return request;
  } else {
    const eventId = eventIdOfSpan(span.id);
    if (eventId !== null) {
      const match = rows.findIndex((row) => row.event_ids.includes(eventId));
      if (match >= 0) return match;
    }
  }

  if (span.turn_id !== null) {
    const header = rows.findIndex(
      (row) => row.kind === "turn_header" && row.turn_id === span.turn_id,
    );
    if (header >= 0) return header;
  }
  return rows.length === 0 ? -1 : 0;
}

/** Index of the first ledger row inside a brushed wall-clock range. */
export function rowIndexForTimeRange(
  rows: readonly LedgerRow[],
  range: LedgerTimeRange | null | undefined,
): number {
  return firstRowIndexInTimeRange(rows, range);
}

/** Turn ordinals (1-based) derived from the ledger's turn headers. */
export function turnNumbers(rows: readonly LedgerRow[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let next = 1;
  for (const row of rows) {
    if (row.kind !== "turn_header" || row.turn_id === null) continue;
    if (numbers.has(row.turn_id)) continue;
    numbers.set(row.turn_id, next);
    next += 1;
  }
  return numbers;
}

/** Move a match cursor by `direction`, wrapping around. */
export function stepMatch(
  current: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count <= 0) return -1;
  if (current < 0) return direction > 0 ? 0 : count - 1;
  return (current + direction + count) % count;
}
