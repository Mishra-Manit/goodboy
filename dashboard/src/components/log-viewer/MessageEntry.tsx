/**
 * Route a single pi session entry to the right card. The tool-result pairing
 * is computed by `LogViewer` and threaded through so tool-call blocks inside
 * assistant messages can display their completed result inline.
 */

import type { SessionEntry, SessionMessageEntry } from "@dashboard/lib/api";
import { formatTime } from "@dashboard/lib/format";
import { UserBubble } from "./UserBubble.js";
import { AssistantTurn } from "./AssistantTurn.js";
import { BashExecutionCard } from "./BashExecutionCard.js";

interface MessageEntryProps {
  entry: SessionEntry;
  toolResults: Map<string, SessionMessageEntry>;
}

export function MessageEntry({ entry, toolResults }: MessageEntryProps) {
  if (entry.type === "compaction") {
    return (
      <InfoRow ts={entry.timestamp}>
        compacted {entry.tokensBefore.toLocaleString()} tokens
      </InfoRow>
    );
  }

  if (entry.type === "branch_summary") {
    return (
      <InfoRow ts={entry.timestamp}>branch summary: {entry.summary.slice(0, 120)}</InfoRow>
    );
  }

  if (entry.type === "custom" || entry.type === "custom_message") {
    return <InfoRow ts={entry.timestamp}>extension entry ({entry.customType})</InfoRow>;
  }

  if (entry.type !== "message") return null;
  const m = entry.message;

  switch (m.role) {
    case "user":
      return <UserBubble message={m} />;
    case "assistant":
      return <AssistantTurn message={m} toolResults={toolResults} />;
    case "bashExecution":
      return <BashExecutionCard message={m} />;
    case "toolResult":
      // Rendered inline with its matching tool call inside AssistantTurn.
      return null;
    case "custom":
      return <InfoRow ts={entry.timestamp}>custom message ({m.customType})</InfoRow>;
  }
  return null;
}

// --- Helpers ---

function InfoRow({ ts, children }: { ts: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px] mt-px">
        {formatTime(ts)}
      </span>
      <span className="text-text-ghost text-[10px] italic">{children}</span>
    </div>
  );
}
