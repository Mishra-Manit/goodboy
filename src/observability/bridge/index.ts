/**
 * Stub. Real implementation lands in Task 8. Exported now so
 * `src/observability/index.ts` type-checks through Tasks 4-6.
 */

import type { Span } from "@opentelemetry/api";

export interface BridgeOptions {
  sessionPath: string;
  stageSpan: Span;
  taskId: string;
}

export function bridgeSessionToOtel(_options: BridgeOptions): () => void {
  return () => {};
}
