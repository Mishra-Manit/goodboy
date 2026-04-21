/**
 * Central tracer accessor. Everything in src/observability uses this so
 * there is one OTel scope name (`goodboy`) in every emitted span.
 */

import { trace, type Tracer } from "@opentelemetry/api";

export const TRACER_NAME = "goodboy";

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
