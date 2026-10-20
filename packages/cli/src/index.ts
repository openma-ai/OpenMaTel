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
  parseSessionsArgs,
  parseShowArgs,
  parseSources,
  parseSourcesArgs,
  resolveDataDir,
  resolveHome,
  runCli,
  runIndex,
  runSessions,
  runShow,
  runSources,
  type IndexOptions,
  type IndexResult,
  type SessionsOptions,
  type ShowOptions,
  type SourceDetection,
  type SourceIndexStats,
  type SourceName,
  type SourcesOptions,
} from "./cli.js";
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
