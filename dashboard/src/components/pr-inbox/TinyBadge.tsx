/** Tiny rounded badge for labels, states, and metadata. */

import { type ReactNode } from "react";
import { cn } from "@dashboard/lib/utils";

interface TinyBadgeProps {
  children: ReactNode;
  tone?: "neutral" | "warn";
}

export function TinyBadge({ children, tone = "neutral" }: TinyBadgeProps) {
  return (
    <span className={cn(
      "rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wide",
      tone === "warn" ? "border-warn/40 text-warn" : "border-glass-border text-text-ghost",
    )}>
      {children}
    </span>
  );
}
