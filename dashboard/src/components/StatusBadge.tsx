import { cn } from "@dashboard/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  // Task-level statuses (generic lifecycle)
  queued: { label: "queued", color: "text-text-dim" },
  running: { label: "running", color: "text-accent" },
  complete: { label: "complete", color: "text-ok" },
  failed: { label: "failed", color: "text-fail" },
  cancelled: { label: "cancelled", color: "text-text-dim" },
};

const ACTIVE_STATUSES = new Set(["running"]);

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    color: "text-text-dim",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide",
        config.color,
        className
      )}
    >
      {ACTIVE_STATUSES.has(status) && (
        <span className="h-1 w-1 rounded-full bg-current animate-pulse-soft" />
      )}
      {config.label}
    </span>
  );
}
