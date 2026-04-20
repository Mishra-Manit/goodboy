/** Unified status pill. Covers task lifecycle, session states, and run states. */

import { cn } from "@dashboard/lib/utils";

interface BadgeConfig {
  label: string;
  color: string;
  pulse?: boolean;
}

const STATUS_CONFIG: Record<string, BadgeConfig> = {
  queued:    { label: "queued",    color: "text-text-dim" },
  running:   { label: "running",   color: "text-accent", pulse: true },
  complete:  { label: "complete",  color: "text-ok" },
  failed:    { label: "failed",    color: "text-fail" },
  cancelled: { label: "cancelled", color: "text-text-dim" },
  active:    { label: "watching",  color: "text-text-dim" },
  closed:    { label: "closed",    color: "text-text-void" },
};

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? { label: status, color: "text-text-dim" };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide",
        config.color,
        className,
      )}
    >
      {config.pulse && <span className="h-1 w-1 rounded-full bg-current animate-pulse-soft" />}
      {config.label}
    </span>
  );
}
