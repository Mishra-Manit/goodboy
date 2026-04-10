import { cn } from "@dashboard/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  queued: { label: "queued", color: "text-text-dim", bg: "bg-transparent" },
  planning: { label: "planning", color: "text-accent", bg: "bg-accent-ghost" },
  implementing: { label: "implementing", color: "text-accent", bg: "bg-accent-ghost" },
  reviewing: { label: "reviewing", color: "text-accent", bg: "bg-accent-ghost" },
  creating_pr: { label: "creating pr", color: "text-accent", bg: "bg-accent-ghost" },
  revision: { label: "revision", color: "text-accent", bg: "bg-accent-ghost" },
  complete: { label: "complete", color: "text-ok", bg: "bg-ok-dim" },
  failed: { label: "failed", color: "text-fail", bg: "bg-fail-dim" },
  cancelled: { label: "cancelled", color: "text-text-dim", bg: "bg-transparent" },
  running: { label: "running", color: "text-accent", bg: "bg-accent-ghost" },
};

const ACTIVE_STATUSES = new Set(
  Object.entries(STATUS_CONFIG)
    .filter(([, v]) => v.color === "text-accent")
    .map(([k]) => k)
);

interface StatusBadgeProps {
  status: string;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    color: "text-text-dim",
    bg: "bg-transparent",
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
