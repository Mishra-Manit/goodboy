/** Compact stat card with label and value. Unifies MemoryCountCard and StatTile patterns. */

import { cn } from "@dashboard/lib/utils";

interface StatCardProps {
  label: string;
  value: string | number;
  accent?: boolean;
  muted?: boolean;
  active?: boolean;
}

export function StatCard({ label, value, accent, muted, active }: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5",
        active ? "border-accent-dim bg-accent-ghost" : "border-glass-border bg-glass/40",
      )}
    >
      <div
        className={cn(
          "font-mono text-xl font-bold tabular-nums",
          accent ? "text-accent" : muted ? "text-text-ghost" : "text-text",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-text-void">
        {label}
      </div>
    </div>
  );
}
