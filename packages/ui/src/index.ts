/**
 * `@openmatel/ui` — the OpenMaTel data boundary and formatters.
 *
 * The v0 detail/timeline components were replaced by the vendored OpenMA
 * console surfaces in `@openmatel/oma-console-ui`. This package now keeps the
 * HTTP Query client, the React provider and the dependency-free formatters.
 *
 * The package only imports **types** from `@openmatel/core` and never touches
 * a store or a server package. Data always arrives through the injected
 * {@link ObsClient}; navigation is injected as a plain callback.
 */

export {
  ObsApiError,
  createObsClient,
  type LlmCallParams,
  type ObsClient,
  type ObsClientOptions,
  type ObsSessionDetail,
  type SegmentFilterParams,
  type SessionListParams,
} from "./client.js";
export {
  ObsProvider,
  useObs,
  useObsOptional,
  type ObsContextValue,
  type ObsProviderProps,
  type ObsTheme,
} from "./provider.js";
export {
  durationBetween,
  formatClock,
  formatCoverage,
  formatDurationMs,
  formatTimestamp,
  formatTokens,
  singleLine,
} from "./format.js";
