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

  const isActive = [
    "planning", "implementing", "reviewing", "creating_pr", "revision", "running",
  ].includes(status);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide",
        config.color,
        className
      )}
    >
      {isActive && (
        <span className={cn("h-1 w-1 rounded-full bg-current animate-pulse-soft")} />
      )}
      {config.label}
    </span>
  );
}
