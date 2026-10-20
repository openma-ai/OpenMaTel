/**
 * The executable entry point. The build puts a `#!/usr/bin/env node` banner
 * in front of the bundled file.
 */

import { runCli } from "./cli.js";

const exitCode = await runCli(process.argv.slice(2));
process.exitCode = exitCode;
