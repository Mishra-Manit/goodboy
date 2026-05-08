/** Reusable row of rounded-full filter pills with active state. */

import { cn } from "@dashboard/lib/utils";

interface FilterPillGroupProps<T extends string> {
  filters: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Optional label transform (e.g. "review_behavior" → "behavior"). */
  labelFn?: (filter: T) => string;
  /** Optional count to display after each label. */
  counts?: Partial<Record<T, number>>;
}

export function FilterPillGroup<T extends string>({
  filters,
  value,
  onChange,
  labelFn,
  counts,
}: FilterPillGroupProps<T>) {
  return (
    <div className="flex flex-wrap gap-1">
      {filters.map((filter) => (
        <button
          key={filter}
          onClick={() => onChange(filter)}
          className={cn(
            "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
            value === filter ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
          )}
        >
          {labelFn ? labelFn(filter) : filter}
          {counts && counts[filter] !== undefined && (
            <span className="ml-1.5 text-text-void">{counts[filter]}</span>
          )}
        </button>
      ))}
    </div>
  );
}
