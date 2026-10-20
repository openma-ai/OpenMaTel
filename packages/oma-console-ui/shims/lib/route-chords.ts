/**
 * Route chords for the OpenMaTel console.
 *
 * Only `/sessions` exists, so `g s` is the only chord the vendored AppShell
 * installs. Keep the shape the console's AppShell expects.
 */

export const ROUTE_CHORDS: Record<string, string> = {
  "/sessions": "s",
};
