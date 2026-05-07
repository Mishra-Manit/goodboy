/** Generic action button with busy state for PR inbox row actions. */

import { type ReactNode } from "react";
import { cn } from "@dashboard/lib/utils";

interface ActionButtonProps {
  busy: boolean;
  onClick: () => Promise<void>;
  children: ReactNode;
}

export function ActionButton({ busy, onClick, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cn(
        "rounded-full border border-glass-border px-3 py-1.5 font-mono text-[10px] transition-colors",
        busy ? "cursor-wait text-text-void" : "text-accent hover:border-accent hover:bg-glass-hover",
      )}
    >
      {busy ? "working..." : children}
    </button>
  );
}
