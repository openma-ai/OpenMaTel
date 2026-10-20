import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The desktop SPA is served by the CLI at the root of the origin.
 *
 * `base: "./"` keeps the generated asset URLs relative (they work when the
 * page is opened through a local server or a file-like wrapper), while the
 * `<base href="/">` in index.html anchors them at the origin so a deep link
 * such as `/sessions/ss_…` still loads `/assets/…`.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    assetsDir: "assets",
  },
});
