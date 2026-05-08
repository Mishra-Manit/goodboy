/** Shared visual tokens for memory run UI. Imported by every memory view. */

import type { MemoryRunKind, MemoryRunSource, MemoryStatusKind } from "@dashboard/shared";

/** Text color per memory run kind. Keep in sync with MEMORY_RUN_KINDS. */
export const KIND_TONE: Record<MemoryRunKind, string> = {
  cold: "text-accent",
  warm: "text-warn",
  skip: "text-text-void",
  noop: "text-text-dim",
};

/** Human-facing label per memory run source. */
export const SOURCE_LABEL: Record<MemoryRunSource, string> = {
  task: "task",
  manual_test: "manual test",
};

/** Text color per memory status (freshness). Single source of truth. */
export const STATUS_TONE: Record<MemoryStatusKind, string> = {
  fresh: "text-accent",
  stale: "text-warn",
  missing: "text-fail",
};
