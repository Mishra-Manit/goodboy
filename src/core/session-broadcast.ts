/**
 * Start/stop a session-file tail that broadcasts every new entry over SSE
 * as a `session_entry` event. One tail per active stage or PR session; the
 * caller (`runStage`, PR-session runner) owns the lifecycle.
 */

import { emit } from "../shared/events.js";
import { watchSessionFile } from "./session-file.js";
import type { StageName } from "../shared/types.js";

interface TaskTarget {
  scope: "task";
  taskId: string;
  stage: StageName;
}

interface PrSessionTarget {
  scope: "pr_session";
  prSessionId: string;
}

export type BroadcastTarget = TaskTarget | PrSessionTarget;

/** Tail `filePath` and rebroadcast each entry. Returns the disposer. */
export function broadcastSessionFile(filePath: string, target: BroadcastTarget): () => void {
  return watchSessionFile(filePath, (entry) => {
    if (target.scope === "task") {
      emit({ type: "session_entry", scope: "task", id: target.taskId, stage: target.stage, entry });
    } else {
      emit({ type: "session_entry", scope: "pr_session", id: target.prSessionId, entry });
    }
  });
}
