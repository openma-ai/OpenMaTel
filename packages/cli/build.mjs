/**
 * Bundle the CLI into one self-contained ESM file.
 *
 * Workspace packages (`@openmatel/core`, `@openmatel/source-local` and
 * `@openmatel/store-sqlite`) are bundled; Node built-ins stay external. The
 * output has no runtime dependency and is directly executable through the
 * `bin` entry.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const shim = fileURLToPath(new URL("./src/sqlite-shim.ts", import.meta.url));

const externals = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
// The built-in is loaded through the lazy shim below; keep it external so the
// bundle never tries to inline the Node.js driver.
externals.add("node:sqlite");
externals.add("sqlite");

mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });

await build({
  absWorkingDir: here,
  entryPoints: ["src/main.ts"],
  outfile: "dist/openmatel.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  external: [...externals],
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  plugins: [
    {
      name: "lazy-node-sqlite",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: shim }));
      },
    },
  ],
});

chmodSync(new URL("./dist/openmatel.mjs", import.meta.url), 0o755);
