/**
 * `@openmatel/ui` — the OpenMaTel React component library.
 *
 * The package only imports **types** from `@openmatel/core` and never touches
 * a store or a server package. Data always arrives through the injected
 * {@link ObsClient}; navigation is injected as a plain callback.
 *
 * Import the stylesheet once in the host application:
 * `import "@openmatel/ui/styles.css";`
 */

export {
  ObsApiError,
  createObsClient,
  type ObsClient,
  type ObsClientOptions,
  type ObsSessionDetail,
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
  SESSION_SOURCES,
  SessionList,
  type SessionListProps,
} from "./SessionList.js";
export { SessionDetail, type SessionDetailProps } from "./SessionDetail.js";
export {
  StepTimeline,
  stepLabel,
  type StepTimelineProps,
} from "./StepTimeline.js";
export { refreshEdgeFade, useEdgeFade } from "./useEdgeFade.js";
export {
  durationBetween,
  formatClock,
  formatCoverage,
  formatDurationMs,
  formatTimestamp,
  formatTokens,
  singleLine,
} from "./format.js";
