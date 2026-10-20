/**
 * Copy the single stylesheet next to the compiled components.
 *
 * `tsc` only emits JavaScript and declarations; the package ships plain CSS,
 * so the build moves `src/styles.css` to `dist/styles.css`.
 */

import { chmodSync, copyFileSync, mkdirSync } from "node:fs";

mkdirSync(new URL("./dist/", import.meta.url), { recursive: true });
copyFileSync(new URL("./src/styles.css", import.meta.url), new URL("./dist/styles.css", import.meta.url));
chmodSync(new URL("./dist/styles.css", import.meta.url), 0o644);
