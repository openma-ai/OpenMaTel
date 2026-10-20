/**
 * `@openmatel/pipeline` — assembly of the ingest stages.
 *
 * The package composes a core {@link import("@openmatel/core").Bus} with the
 * processor chain and the sinks, and ships the pull-source driver the CLI
 * uses to index local session files. It depends on `@openmatel/core` only;
 * sources, sinks and the bus are injected by the composition root.
 */

export {
  createPipeline,
  type Pipeline,
  type PipelineErrorContext,
  type PipelineOptions,
  type PipelineStage,
  type PipelineStats,
} from "./pipeline.js";
export {
  runLocalIndex,
  type CursorStore,
  type LocalIndexErrorContext,
  type LocalIndexFile,
  type LocalIndexPipeline,
  type LocalIndexResult,
  type LocalIndexSource,
  type LocalIndexSources,
  type LocalIndexSourceStats,
  type LocalIndexStage,
  type LocalIndexStore,
  type RunLocalIndexOptions,
} from "./local-index.js";
