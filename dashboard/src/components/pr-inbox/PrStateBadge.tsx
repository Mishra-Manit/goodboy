/** PR state badge with color-coded tone per inbox state. */

import type { PrInboxRow } from "@dashboard/lib/api";
import { cn } from "@dashboard/lib/utils";

interface PrStateBadgeProps {
  state: PrInboxRow["state"];
}

const LABEL: Record<PrInboxRow["state"], string> = {
  not_started: "not started",
  owned: "owned",
  review_running: "review running",
  review_failed: "review failed",
  reviewed: "reviewed",
};

const TONE: Record<PrInboxRow["state"], string> = {
  not_started: "border-glass-border text-text-ghost",
  owned: "border-accent/40 text-accent",
  review_running: "border-warn/40 text-warn",
  review_failed: "border-fail/40 text-fail",
  reviewed: "border-ok/40 text-ok",
};

export function PrStateBadge({ state }: PrStateBadgeProps) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wide", TONE[state])}>
      {LABEL[state]}
    </span>
  );
}
