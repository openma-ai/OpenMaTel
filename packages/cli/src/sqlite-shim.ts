/**
 * Build-time shim for `node:sqlite`.
 *
 * A static `import { DatabaseSync } from "node:sqlite"` is hoisted above the
 * warning filter by the bundler, which means Node prints its experimental
 * warning before the CLI can suppress exactly that warning. The build maps
 * `node:sqlite` to this module, which loads the built-in lazily through
 * `createRequire`; the warning filter is installed before the store is
 * imported, so the filter is in place when the require runs.
 *
 * This file is bundled into `dist/openmatel.mjs`; it is not a runtime
 * dependency.
 */

import { createRequire } from "node:module";
import type {
  DatabaseSync as DatabaseSyncType,
  StatementSync as StatementSyncType,
} from "node:sqlite";

const require = createRequire(import.meta.url);
const sqlite = require("node:sqlite") as typeof import("node:sqlite");

/** Re-export of the SQLite driver class. */
export const DatabaseSync: typeof DatabaseSyncType = sqlite.DatabaseSync;

/** Re-export of the driver's statement type. */
export type StatementSync = StatementSyncType;
