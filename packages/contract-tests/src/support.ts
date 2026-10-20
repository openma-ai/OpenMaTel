/**
 * Small helpers shared by the contract suites.
 *
 * They are internal: the public surface of the package is the contract
 * functions and the fixtures.
 */

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Options of {@link waitUntil}. */
export interface WaitOptions {
  /** How long to wait before giving up. Default: 2000ms. */
  timeoutMs?: number;
  /** How long to wait between two checks. Default: 10ms. */
  intervalMs?: number;
}

/**
 * Wait until `predicate` returns `true`.
 *
 * @throws when the predicate did not become true within the timeout.
 */
export async function waitUntil(
  predicate: () => boolean,
  options: WaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

/**
 * Compare two arrays of strings, ignoring their order.
 *
 * @returns the elements that only one of the arrays has, if any.
 */
export function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  return [
    ...[...leftSet].filter((item) => !rightSet.has(item)),
    ...[...rightSet].filter((item) => !leftSet.has(item)),
  ];
}
