/** Single source of truth for every watchable PR -- own and reviewed. */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchPrSessions, setPrSessionWatchStatus, type PrSession } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { PrSessionRow } from "@dashboard/components/rows/PrSessionRow";
import { cn } from "@dashboard/lib/utils";

const MODE_FILTERS = ["all", "own", "review"] as const;
type ModeFilter = (typeof MODE_FILTERS)[number];

export function PullRequests() {
  const navigate = useNavigate();
  const { data: sessions, loading, refetch } = useQuery(() => fetchPrSessions());
  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");

  useSSERefresh(refetch, (e) => e.type === "task_update" || e.type === "pr_session_update");

  useSSE((event) => {
    if (event.type !== "pr_session_update") return;
    setRunningSessions((prev) => {
      const next = new Set(prev);
      if (event.running) next.add(event.prSessionId);
      else next.delete(event.prSessionId);
      return next;
    });
  });

  const filtered = useMemo(() => {
    const all = sessions ?? [];
    if (modeFilter === "all") return all;
    return all.filter((s) => s.mode === modeFilter);
  }, [sessions, modeFilter]);

  const active = filtered.filter((s) => s.status === "active");
  const closed = filtered.filter((s) => s.status === "closed");

  async function handleToggleWatch(session: PrSession) {
    if (updatingId) return;
    const next = session.watchStatus === "muted" ? "watching" : "muted";
    setUpdatingId(session.id);
    try {
      await setPrSessionWatchStatus(session.id, next);
      refetch();
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">Pull Requests</h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          Every PR goodboy is watching -- created or reviewed
        </p>
      </header>

      <ModeFilters value={modeFilter} onChange={setModeFilter} />

      {loading && !sessions ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">loading...</span>
        </div>
      ) : (
        <>
          <Section label="active" count={active.length} emptyLabel="No active PR sessions">
            {active.map((session) => (
              <PrSessionRow
                key={session.id}
                session={session}
                running={runningSessions.has(session.id)}
                updatingWatch={updatingId === session.id}
                onClick={() => navigate(`/prs/${session.id}`)}
                onToggleWatch={handleToggleWatch}
                onTaskClick={
                  session.sourceTaskId ? () => navigate(`/tasks/${session.sourceTaskId}`) : undefined
                }
              />
            ))}
          </Section>

          {closed.length > 0 && (
            <Section label="closed" count={closed.length} className="mt-8">
              {closed.map((session) => (
                <PrSessionRow
                  key={session.id}
                  session={session}
                  running={false}
                  updatingWatch={false}
                  onClick={() => navigate(`/prs/${session.id}`)}
                  onToggleWatch={handleToggleWatch}
                  onTaskClick={
                    session.sourceTaskId ? () => navigate(`/tasks/${session.sourceTaskId}`) : undefined
                  }
                />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// --- Helpers ---

interface ModeFiltersProps { value: ModeFilter; onChange: (v: ModeFilter) => void }

function ModeFilters({ value, onChange }: ModeFiltersProps) {
  return (
    <div className="mb-6 flex gap-1">
      {MODE_FILTERS.map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={cn(
            "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
            value === m ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
          )}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

interface SectionProps {
  label: string;
  count: number;
  emptyLabel?: string;
  className?: string;
  children: React.ReactNode;
}

function Section({ label, count, emptyLabel, className, children }: SectionProps) {
  return (
    <>
      <SectionDivider label={label} detail={count > 0 ? `${count}` : undefined} className={className} />
      {count === 0 && emptyLabel ? (
        <div className="py-8 text-center">
          <span className="font-mono text-[11px] text-text-ghost">{emptyLabel}</span>
        </div>
      ) : (
        <div className="mt-3 space-y-0.5 stagger">{children}</div>
      )}
    </>
  );
}
