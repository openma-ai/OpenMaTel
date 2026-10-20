import { describe, expect, it } from "vitest";

import type { Usage } from "./schema.js";
import { emptyUsage, sumUsage } from "./usage.js";

const usage = (overrides: Partial<Usage> = {}): Usage => ({
  ...emptyUsage("provider"),
  ...overrides,
});

describe("emptyUsage", () => {
  it("reports every token field as unknown, not as zero", () => {
    const empty = emptyUsage();
    expect(empty).toEqual({
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      reasoning_tokens: null,
      source: "missing",
    });
  });

  it("takes the source", () => {
    expect(emptyUsage("estimated").source).toBe("estimated");
  });
});

describe("sumUsage", () => {
  it("returns an empty result for an empty list", () => {
    const result = sumUsage([]);
    expect(result.calls).toBe(0);
    expect(result.covered).toBe(0);
    expect(result.coverage).toBeNull();
    expect(result.total.input_tokens).toBeNull();
    expect(result.total.output_tokens).toBeNull();
  });

  it("keeps a missing field missing instead of turning it into zero", () => {
    const result = sumUsage([emptyUsage("missing")]);
    expect(result.total.input_tokens).toBeNull();
    expect(result.total.output_tokens).toBeNull();
    expect(result.total.cache_read_tokens).toBeNull();
    expect(result.total.cache_write_tokens).toBeNull();
    expect(result.total.reasoning_tokens).toBeNull();
    expect(result.total.cost_usd).toBeNull();
    expect(result.calls).toBe(1);
    expect(result.covered).toBe(0);
    expect(result.coverage).toBe(0);
  });

  it("sums reported tokens", () => {
    const result = sumUsage([
      usage({ input_tokens: 100, output_tokens: 20 }),
      usage({ input_tokens: 50, output_tokens: 5 }),
    ]);
    expect(result.total.input_tokens).toBe(150);
    expect(result.total.output_tokens).toBe(25);
    expect(result.calls).toBe(2);
    expect(result.covered).toBe(2);
    expect(result.coverage).toBe(1);
  });

  it("keeps zero as zero and counts it as covered", () => {
    const result = sumUsage([
      usage({ input_tokens: 0, output_tokens: 0 }),
      usage({ input_tokens: null, output_tokens: null, source: "missing" }),
    ]);
    expect(result.total.input_tokens).toBe(0);
    expect(result.total.output_tokens).toBe(0);
    expect(result.calls).toBe(2);
    expect(result.covered).toBe(1);
    expect(result.coverage).toBe(0.5);
  });

  it("counts a call without usage as uncovered", () => {
    const result = sumUsage([usage({ input_tokens: 0 }), null]);
    expect(result.total.input_tokens).toBe(0);
    expect(result.calls).toBe(2);
    expect(result.covered).toBe(1);
    expect(result.coverage).toBe(0.5);
  });

  it("leaves a field null when no call reported it", () => {
    const result = sumUsage([usage({ input_tokens: 10, output_tokens: 3 })]);
    expect(result.total.input_tokens).toBe(10);
    expect(result.total.output_tokens).toBe(3);
    expect(result.total.cache_read_tokens).toBeNull();
    expect(result.total.reasoning_tokens).toBeNull();
  });

  it("counts estimated usage as covered", () => {
    const result = sumUsage([usage({ input_tokens: 5, source: "estimated" })]);
    expect(result.covered).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it("sums the cost of the calls that reported one", () => {
    const result = sumUsage([
      usage({ input_tokens: 1, cost_usd: 0.5 }),
      usage({ input_tokens: 1 }),
    ]);
    expect(result.total.cost_usd).toBe(0.5);
  });
});
