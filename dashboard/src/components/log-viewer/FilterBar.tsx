/** Tabbed filter row shown above the log stream. */

import { cn } from "@dashboard/lib/utils";

export type FilterMode = "all" | "tools" | "text" | "errors";

interface FilterTabProps {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  className?: string;
}

function FilterTab({ active, onClick, label, count, className }: FilterTabProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2 py-0.5 rounded font-mono text-[10px] transition-all duration-150",
        active ? "bg-glass text-text-secondary" : "text-text-void hover:text-text-ghost",
        className,
      )}
    >
      {label}
      <span className="ml-1 text-text-void">{count}</span>
    </button>
  );
}

interface FilterBarProps {
  filter: FilterMode;
  onChange: (mode: FilterMode) => void;
  counts: { all: number; tools: number; text: number; errors: number };
}

export function FilterBar({ filter, onChange, counts }: FilterBarProps) {
  return (
    <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-glass-border">
      <FilterTab active={filter === "all"} onClick={() => onChange("all")} label="all" count={counts.all} />
      <FilterTab active={filter === "tools"} onClick={() => onChange("tools")} label="tools" count={counts.tools} />
      <FilterTab active={filter === "text"} onClick={() => onChange("text")} label="text" count={counts.text} />
      {counts.errors > 0 && (
        <FilterTab
          active={filter === "errors"}
          onClick={() => onChange("errors")}
          label="errors"
          count={counts.errors}
          className="text-fail/70"
        />
      )}
    </div>
  );
}
