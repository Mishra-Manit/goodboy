/** Small ok/err/running pill used on every tool-group row. */

import { cn } from "@dashboard/lib/utils";

interface OutcomePillProps {
  done: boolean;
  ok: boolean;
  className?: string;
}

export function OutcomePill({ done, ok, className }: OutcomePillProps) {
  const [label, tone] = !done
    ? ["running", "text-accent/70 bg-accent-dim/40"]
    : ok
    ? ["ok", "text-ok/70 bg-ok-dim"]
    : ["err", "text-fail/70 bg-fail-dim"];

  return (
    <span className={cn("text-[9px] font-medium px-1 py-px rounded", tone, className)}>
      {label}
    </span>
  );
}
