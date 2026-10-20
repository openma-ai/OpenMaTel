/**
 * Programmatic entry point of the `openmatel` CLI.
 *
 * The binary is `src/main.ts`; these exports make the command functions
 * testable without spawning a process.
 */

export {
  ALL_SOURCES,
  HELP_TEXT,
  UsageError,
  hasZstdSupport,
  parseIndexArgs,
  parseServeArgs,
  parseSessionsArgs,
  parseShowArgs,
  parseSources,
  parseSourcesArgs,
  resolveDataDir,
  resolveHome,
  runCli,
  runIndex,
  runServe,
  runSessions,
  runShow,
  runSources,
  type IndexOptions,
  type IndexResult,
  type ServeOptions,
  type SessionsOptions,
  type ShowOptions,
  type SourceDetection,
  type SourceIndexStats,
  type SourceName,
  type SourcesOptions,
} from "./cli.js";
export {
  DEFAULT_HOST,
  DEFAULT_PORT,
  createStaticAssets,
  createToken,
  openBrowser,
  resolveUiDir,
  startServe,
  type ServeHandle,
  type StartServeOptions,
} from "./serve.js";
export {
  display,
  durationBetween,
  formatCoverage,
  formatDurationMs,
  formatLocalTime,
  formatLocalTimestamp,
  formatTokens,
  renderTable,
  shortSessionId,
  truncateText,
} from "./format.js";
export { createMemoryIO, processIO, type CommandIO } from "./io.js";
export { databasePath, openStore } from "./store.js";
export { VERSION } from "./version.js";
