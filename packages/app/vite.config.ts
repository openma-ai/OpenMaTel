import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const vendor = fileURLToPath(new URL("../oma-console-ui/vendor", import.meta.url));
const shims = fileURLToPath(new URL("../oma-console-ui/shims", import.meta.url));

/**
 * The vendored console files are byte-identical to OpenMA's. Their relative
 * imports are redirected to the local shims here (Vite) and through
 * `rootDirs` in tsconfig.json (TypeScript), so no vendored file is edited by
 * hand.
 */
const shimAliases = [
  { find: /^\.\.\/lib\/auth$/, replacement: `${shims}/lib/auth.tsx` },
  { find: /^\.\.\/lib\/branding$/, replacement: `${shims}/lib/branding.ts` },
  { find: /^\.\.\/lib\/theme$/, replacement: `${shims}/lib/theme.ts` },
  { find: /^\.\.\/lib\/route-chords$/, replacement: `${shims}/lib/route-chords.ts` },
  { find: /^\.\.\/i18n$/, replacement: `${shims}/i18n/index.ts` },
  { find: /^\.\.\/plugins\/registry$/, replacement: `${shims}/plugins/registry.ts` },
  { find: /^\.\/TenantSwitcher$/, replacement: `${shims}/components/TenantSwitcher.tsx` },
  { find: /^\.\/UserProfile$/, replacement: `${shims}/components/UserProfile.tsx` },
  { find: /^\.\/CommandPalette$/, replacement: `${shims}/components/CommandPalette.tsx` },
];

/**
 * The desktop SPA is served by the CLI at the root of the origin.
 *
 * `base: "./"` keeps the generated asset URLs relative, while the
 * `<base href="/">` in index.html anchors them at the origin so a deep link
 * such as `/sessions/ses_…` still loads `/assets/…`.
 */
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      ...shimAliases,
      { find: /^@\//, replacement: `${vendor}/` },
      { find: /^@console-shims\//, replacement: `${shims}/` },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    assetsDir: "assets",
  },
});
