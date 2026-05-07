/** Notice banner showing reconcile preview/result. */

import type { PrSessionReconcileSummary } from "@dashboard/lib/api";

interface ReconcileNoticeProps {
  summary: PrSessionReconcileSummary;
}

export function ReconcileNotice({ summary }: ReconcileNoticeProps) {
  const changed = summary.recreated + summary.muted;
  const pending = summary.wouldRecreate + summary.wouldMute;
  const detail = summary.applied
    ? `${changed} repaired, ${summary.healthy} healthy, ${summary.errors} errors`
    : `${pending} need repair, ${summary.healthy} healthy`;

  return (
    <div className="mb-5 rounded-lg border border-glass-border bg-glass px-4 py-3">
      <p className="font-mono text-[11px] text-text">PR session reconcile {summary.applied ? "applied" : "preview"}</p>
      <p className="mt-1 font-mono text-[10px] text-text-ghost">{detail}</p>
    </div>
  );
}
