/** User prompt rendering. Pi wraps strings in TextContent[] but can also be a plain string. */

import type { UserMessage } from "@dashboard/lib/api";
import { joinText } from "./helpers.js";

interface UserBubbleProps {
  message: UserMessage;
}

export function UserBubble({ message }: UserBubbleProps) {
  const text = typeof message.content === "string" ? message.content : joinText(message.content);
  return (
    <div className="rounded-md bg-glass px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-wider text-text-ghost mb-1">user</div>
      <div className="whitespace-pre-wrap text-text-secondary text-[11px] leading-relaxed">{text}</div>
    </div>
  );
}
