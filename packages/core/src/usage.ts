/**
 * Usage aggregation.
 *
 * The whole point of this module is the difference between *missing* and
 * *zero* (§4.5):
 *
 * - A field that no call reported stays `null` — it never becomes `0`.
 * - A field that a call reported as `0` contributes `0` to the sum.
 * - `coverage` tells the UI how much of the session is actually accounted for,
 *   so "18.1k tokens (covered 67%)" can be rendered honestly.
 */

import { USAGE_TOKEN_FIELDS, type Usage, type UsageSource } from "./schema.js";

/** A usage figure with every field known or explicitly unknown. */
export interface UsageTotal {
  /** Summed tokens and cost. `null` means "no call reported this". */
  total: {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
    reasoning_tokens: number | null;
    cost_usd: number | null;
  };
  /** Number of calls the aggregation looked at (calls without usage included). */
  calls: number;
  /** Number of calls that reported usable usage. */
  covered: number;
  /** `covered / calls`, or `null` when there is nothing to cover. */
  coverage: number | null;
}

/**
 * A usage record with every token field unknown.
 *
 * @param source - where the (empty) record comes from; `"missing"` by default.
 */
export function emptyUsage(source: UsageSource = "missing"): Usage {
  return {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    source,
  };
}

/**
 * Sum a list of usage records.
 *
 * A field is summed only over the records that actually reported it. If no
 * record reported a field, the sum is `null` — never `0`. A record that
 * reported `0` is a real value and keeps the sum at `0`.
 *
 * @param usages - usage of every call; `null`/`undefined` entries count as
 *                 calls without usage (they lower the coverage, they do not
 *                 contribute tokens).
 */
export function sumUsage(usages: (Usage | null | undefined)[]): UsageTotal {
  const total: UsageTotal["total"] = {
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    cost_usd: null,
  };

  const calls = usages.length;
  let covered = 0;

  for (const usage of usages) {
    if (usage === null || usage === undefined) continue;

    let reportedToken = false;
    for (const field of USAGE_TOKEN_FIELDS) {
      const value = usage[field];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      reportedToken = true;
      total[field] = (total[field] ?? 0) + value;
    }

    const cost = usage.cost_usd;
    if (typeof cost === "number" && Number.isFinite(cost)) {
      total.cost_usd = (total.cost_usd ?? 0) + cost;
    }

    if (usage.source !== "missing" && reportedToken) covered += 1;
  }

  return {
    total,
    calls,
    covered,
    coverage: calls === 0 ? null : covered / calls,
  };
}
