/**
 * Public surface of the observability module. Other modules import only
 * from here; no file outside src/observability/ imports Logfire or the
 * raw OTel API.
 */

export { initObservability, shutdownObservability } from "./logfire.js";
export { withPipelineSpan, withStageSpan } from "./spans.js";
export { bridgeSessionToOtel } from "./bridge/index.js";
