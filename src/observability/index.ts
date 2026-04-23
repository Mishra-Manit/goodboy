/**
 * Public surface of the observability module. Other modules import only
 * from here; no file outside src/observability/ imports Logfire or the
 * raw OTel API.
 */

export { initObservability, shutdownObservability } from "./logfire.js";
export { withPipelineSpan, withStageSpan } from "./spans.js";
export { bridgeSessionToOtel } from "./bridge/index.js";

import { getTracer } from "./tracer.js";

/** One-shot event emit: opens and immediately ends a span with attributes. */
export function emitStartupEvent(name: string, attrs: Record<string, string | number>): void {
  const span = getTracer().startSpan(name);
  for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
  span.end();
}
