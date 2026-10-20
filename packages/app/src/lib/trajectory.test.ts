import { describe, expect, it } from "vitest";

import {
  anchoredScrollTop,
  buildRowLayout,
  clampViewport,
  findVisibleRange,
  FULL_VIEWPORT,
  isFullViewport,
  isNearBottom,
  LEDGER_ROW_HEIGHT,
  LEDGER_SEPARATOR_HEIGHT,
  ledgerRowHeight,
  ledgerWindowFraction,
  MIN_VIEWPORT_SPAN,
  modelToScreenFraction,
  panViewport,
  rowIndexForSpan,
  rowOffset,
  screenToModelFraction,
  scrollTopForRow,
  shouldFollowTail,
  stepMatch,
  turnNumbers,
  viewportSpan,
  zoomViewport,
} from "./trajectory";
import type { LedgerRow } from "./ledger";

const row = (
  id: string,
  kind: LedgerRow["kind"],
  overrides: Partial<LedgerRow> = {},
): LedgerRow => ({
  id,
  kind,
  turn_id: "turn_1",
  segment_id: "seg_0",
  step: null,
  request_index: null,
  start: null,
  end: null,
  event_ids: [],
  summary: id,
  error: false,
  status: "ok",
  ...overrides,
});

describe("overview viewport", () => {
  it("clamps ranges into the domain and keeps a minimum span", () => {
    expect(clampViewport(-1, 2)).toEqual({ start: 0, end: 1 });
    expect(clampViewport(2, 3)).toEqual({ start: 0, end: 1 });
    const tiny = clampViewport(0.5, 0.5);
    expect(viewportSpan(tiny)).toBeCloseTo(MIN_VIEWPORT_SPAN);
    expect(tiny.start).toBeCloseTo(0.5);
  });

  it("keeps the model point under the cursor while zooming in", () => {
    const before = FULL_VIEWPORT;
    const modelBefore = screenToModelFraction(before, 0.25);
    const zoomed = zoomViewport(before, 0.25, -100);

    expect(viewportSpan(zoomed)).toBeCloseTo(0.8);
    expect(screenToModelFraction(zoomed, 0.25)).toBeCloseTo(modelBefore);
    expect(zoomed.start).toBeGreaterThan(0);
  });

  it("zooms out back to the full viewport and never past it", () => {
    const zoomed = zoomViewport(FULL_VIEWPORT, 0.5, -100);
    const out = zoomViewport(zoomed, 0.5, 100);
    const further = zoomViewport(out, 0.5, 100);

    expect(isFullViewport(out)).toBe(true);
    expect(isFullViewport(further)).toBe(true);
  });

  it("does not pan beyond either edge and preserves the span", () => {
    const zoomed = clampViewport(0.4, 0.6);
    const left = panViewport(zoomed, -1);
    const right = panViewport(zoomed, 1);

    expect(left.start).toBe(0);
    expect(viewportSpan(left)).toBeCloseTo(0.2);
    expect(right.end).toBe(1);
    expect(viewportSpan(right)).toBeCloseTo(0.2);
  });

  it("maps a model fraction outside a zoomed viewport without clamping", () => {
    const viewport = clampViewport(0.4, 0.6);

    expect(modelToScreenFraction(viewport, 0.4)).toBeCloseTo(0);
    expect(modelToScreenFraction(viewport, 0.6)).toBeCloseTo(1);
    expect(modelToScreenFraction(viewport, 0.2)).toBeCloseTo(-1);
    expect(screenToModelFraction(viewport, 0.5)).toBeCloseTo(0.5);
  });

  it("describes the ledger window as a normalised range", () => {
    expect(ledgerWindowFraction(10, 20, 100)).toEqual({
      start: 0.1,
      end: 0.2,
    });
    expect(ledgerWindowFraction(0, 0, 0)).toBeNull();
  });
});

describe("ledger row layout", () => {
  it("builds prefix offsets for mixed fixed/waterfall heights", () => {
    const layout = buildRowLayout([28, 320, 28]);
    expect(layout.offsets).toEqual([0, 28, 348, 376]);
    expect(layout.total).toBe(376);
    expect(rowOffset(layout, 1)).toBe(28);
    expect(rowOffset(layout, 99)).toBe(376);
  });

  it("finds the visible window and applies overscan", () => {
    const layout = buildRowLayout(Array.from({ length: 100 }, () => 28));

    expect(findVisibleRange(layout, 0, 56, 0)).toEqual({ start: 0, end: 2 });
    expect(findVisibleRange(layout, 280, 56, 0)).toEqual({ start: 10, end: 12 });
    expect(findVisibleRange(layout, 290, 56, 0)).toEqual({ start: 10, end: 13 });
    expect(findVisibleRange(layout, 280, 56, 2)).toEqual({ start: 8, end: 14 });
    expect(findVisibleRange(layout, 10_000, 56, 2)).toEqual({
      start: 97,
      end: 100,
    });
    expect(findVisibleRange(buildRowLayout([]), 0, 100)).toEqual({
      start: 0,
      end: 0,
    });
  });

  it("can scroll to a row offset", () => {
    const layout = buildRowLayout([28, 320, 28]);
    expect(scrollTopForRow(layout, 2)).toBe(348);
  });

  it("uses a compact fixed height for request separators", () => {
    expect(ledgerRowHeight("request")).toBe(LEDGER_SEPARATOR_HEIGHT);
    expect(ledgerRowHeight("tool")).toBe(LEDGER_ROW_HEIGHT);
    expect(ledgerRowHeight("step")).toBe(LEDGER_ROW_HEIGHT);

    const layout = buildRowLayout(
      (["tool", "request", "assistant"] as const).map(ledgerRowHeight),
    );
    expect(layout.total).toBe(
      LEDGER_ROW_HEIGHT * 2 + LEDGER_SEPARATOR_HEIGHT,
    );
    expect(layout.offsets[2]).toBe(LEDGER_ROW_HEIGHT + LEDGER_SEPARATOR_HEIGHT);
  });

  it("keeps the reading position when earlier history is prepended", () => {
    expect(anchoredScrollTop(1_000, 200, 1_400)).toBe(600);
    expect(anchoredScrollTop(1_000, 200, 400)).toBe(0);
  });

  it("detects the bottom and decides when to follow the tail", () => {
    expect(isNearBottom(900, 100, 1_000)).toBe(true);
    expect(isNearBottom(800, 100, 1_000)).toBe(false);
    expect(
      shouldFollowTail({ status: "running", atBottom: true, rowsGrew: false }),
    ).toBe(true);
    expect(
      shouldFollowTail({ status: "unknown", atBottom: true, rowsGrew: false }),
    ).toBe(true);
    expect(
      shouldFollowTail({ status: "ok", atBottom: true, rowsGrew: true }),
    ).toBe(true);
    expect(
      shouldFollowTail({ status: "ok", atBottom: false, rowsGrew: true }),
    ).toBe(false);
    expect(
      shouldFollowTail({ status: "running", atBottom: false, rowsGrew: false }),
    ).toBe(false);
  });
});

describe("overview span → ledger row", () => {
  const rows = [
    row("turn:turn_1:header", "turn_header"),
    row("request:turn_1:1", "request", {
      request_index: 1,
      event_ids: ["ev_llm_1"],
    }),
    row("tool:ev_tool", "tool", { event_ids: ["ev_tool"] }),
    row("turn:turn_2:header", "turn_header", { turn_id: "turn_2" }),
  ];

  it("maps model spans to the request separator", () => {
    expect(
      rowIndexForSpan(rows, {
        id: "llm:st:1",
        kind: "llm",
        turn_id: "turn_1",
        request_index: 1,
      }),
    ).toBe(1);
  });

  it("maps input and tool spans by their event id", () => {
    expect(
      rowIndexForSpan(rows, {
        id: "tool:ev_tool",
        kind: "tool",
        turn_id: "turn_1",
        request_index: null,
      }),
    ).toBe(2);
    expect(
      rowIndexForSpan(rows, {
        id: "input:ev_missing",
        kind: "input",
        turn_id: "turn_2",
        request_index: null,
      }),
    ).toBe(3);
  });

  it("falls back to the first row for an empty list", () => {
    expect(
      rowIndexForSpan([], {
        id: "x:y",
        kind: "tool",
        turn_id: null,
        request_index: null,
      }),
    ).toBe(-1);
  });
});

describe("turn numbering and search stepping", () => {
  it("numbers turns in ledger order, ignoring duplicates", () => {
    const rows = [
      row("a", "turn_header", { turn_id: "turn_a" }),
      row("a2", "user", { turn_id: "turn_a" }),
      row("b", "turn_header", { turn_id: "turn_b" }),
    ];
    expect([...turnNumbers(rows)]).toEqual([
      ["turn_a", 1],
      ["turn_b", 2],
    ]);
  });

  it("wraps search navigation in both directions", () => {
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
