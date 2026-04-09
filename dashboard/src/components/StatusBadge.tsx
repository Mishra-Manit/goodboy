import { cn } from "@dashboard/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  queued: { label: "Queued", className: "bg-zinc-700 text-zinc-300" },
  planning: { label: "Planning", className: "bg-blue-500/20 text-blue-400" },
  implementing: {
    label: "Implementing",
    className: "bg-violet-500/20 text-violet-400",
  },
  reviewing: {
    label: "Reviewing",
    className: "bg-amber-500/20 text-amber-400",
  },
  creating_pr: {
    label: "Creating PR",
    className: "bg-cyan-500/20 text-cyan-400",
  },
  revision: {
    label: "Revision",
    className: "bg-orange-500/20 text-orange-400",
  },
  complete: {
    label: "Complete",
    className: "bg-emerald-500/20 text-emerald-400",
  },
  failed: { label: "Failed", className: "bg-red-500/20 text-red-400" },
  cancelled: {
    label: "Cancelled",
    className: "bg-zinc-600/20 text-zinc-400",
  },
  running: { label: "Running", className: "bg-blue-500/20 text-blue-400" },
};

interface StatusBadgeProps {
  status: string;
  className?: string;
  pulse?: boolean;
}

export function StatusBadge({ status, className, pulse }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? {
    label: status,
    className: "bg-zinc-700 text-zinc-300",
  };

  const isActive = [
    "planning",
    "implementing",
    "reviewing",
    "creating_pr",
    "revision",
    "running",
  ].includes(status);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        config.className,
        className
      )}
    >
      {(pulse ?? isActive) && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {config.label}
    </span>
  );
}
