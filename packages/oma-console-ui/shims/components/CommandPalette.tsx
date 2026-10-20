/**
 * Command-palette shim.
 *
 * The console palette is a cross-page router with commands for every
 * console resource. OpenMaTel has one route, so the shell renders no palette.
 */

export function CommandPalette() {
  return null;
}

export function openCommandPalette(): void {
  // No palette in the single-route OpenMaTel console.
}
