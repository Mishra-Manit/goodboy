/** Eye toggle button for watch/mute PR session status. */

import type { PrInboxRow } from "@dashboard/lib/api";
import { cn } from "@dashboard/lib/utils";

interface WatchButtonProps {
  row: PrInboxRow;
  updating: boolean;
  onToggle: () => Promise<void>;
}

export function WatchButton({ row, updating, onToggle }: WatchButtonProps) {
  if (!row.watchSessionId || !row.watchStatus) return null;
  const watching = row.watchStatus === "watching";

  return (
    <button
      type="button"
      disabled={updating}
      title={watching ? "Mute PR session" : "Watch PR session"}
      onClick={onToggle}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors",
        updating ? "cursor-wait text-text-void" : "text-text-ghost hover:bg-glass hover:text-accent",
        watching && !updating && "text-accent",
      )}
    >
      <EyeIcon muted={!watching} />
    </button>
  );
}

function EyeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
      {muted && <path d="M4 20 20 4" />}
    </svg>
  );
}
