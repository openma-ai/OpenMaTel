/**
 * Branding shim.
 *
 * The console fetches deployment branding from the OpenMA control plane.
 * OpenMaTel always uses its own product name and the shipped Logo mark.
 */

export interface Branding {
  productName: string;
  logoUrl: string | null;
  logoDarkUrl: string | null;
}

export const DEFAULT_BRANDING: Branding = {
  productName: "OpenMaTel",
  logoUrl: null,
  logoDarkUrl: null,
};

export function useBranding(): Branding {
  return DEFAULT_BRANDING;
}
