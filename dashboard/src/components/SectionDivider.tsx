/** Thin horizontal divider with an inline section label. */

import { cn } from "@dashboard/lib/utils";

interface SectionDividerProps {
  label: string;
  detail?: string;
  className?: string;
}

export function SectionDivider({ label, detail, className }: SectionDividerProps) {
  return (
    <div className={cn("flex items-center gap-3 py-1", className)}>
      <div className="h-px flex-1 bg-text-void" />
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-text-ghost">
        {label}
      </span>
      {detail && <span className="font-mono text-[10px] text-text-void">{detail}</span>}
      <div className="h-px flex-1 bg-text-void" />
    </div>
  );
}
