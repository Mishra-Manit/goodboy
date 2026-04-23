/** Memory run history page. Live runs pinned on top, history grouped by repo. */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  deleteMemoryTests,
  fetchMemoryRuns,
  fetchMemoryStatus,
  fetchRepos,
  type MemoryRun,
  type MemoryStatus,
  type Repo,
} from "@dashboard/lib/api";
import { MEMORY_RUN_KINDS, type MemoryRunKind } from "@dashboard/shared";
import { Card } from "@dashboard/components/Card";
import { PageState } from "@dashboard/components/PageState";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { MemoryRunRow } from "@dashboard/components/rows/MemoryRunRow";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useNow } from "@dashboard/hooks/use-now";
import { cn, shortId } from "@dashboard/lib/utils";
import { timeAgo } from "@dashboard/lib/format";

interface MemoryPageData {
  repos: Repo[];
  runs: MemoryRun[];
  statusByRepo: Record<string, MemoryStatus>;
}

const KIND_FILTERS = ["all", ...MEMORY_RUN_KINDS] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

export function Memory() {
  const navigate = useNavigate();
  const now = useNow();
  const [hideTests, setHideTests] = useState(false);
  const [kind, setKind] = useState<KindFilter>("all");
  const [runsVersion, setRunsVersion] = useState(0);
  const [cleaning, setCleaning] = useState(false);

  const query = useQuery(
    () => loadMemoryPage({ hideTests, kind }),
    [hideTests, kind, runsVersion],
  );

  useSSERefresh(
    query.refetch,
    (event) => event.type === "memory_run_update",
  );

  async function handleCleanTests(): Promise<void> {
    if (!window.confirm("Delete all TEST memory runs and their local artifacts?")) return;

    setCleaning(true);
    try {
      await deleteMemoryTests();
      setRunsVersion((value) => value + 1);
    } finally {
      setCleaning(false);
    }
  }

  const openRun = (run: MemoryRun) => navigate(`/memory/${run.id}`);

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">Memory</h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          cold, warm, skip, and noop memory runs across all visible repos
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <KindFilters value={kind} onChange={setKind} />
        <button
          onClick={() => setHideTests((value) => !value)}
          className={cn(
            "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
            hideTests ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
          )}
        >
          {hideTests ? "tests hidden" : "show tests"}
        </button>
        <button
          onClick={() => void handleCleanTests()}
          disabled={cleaning}
          className={cn(
            "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
            "text-text-ghost hover:text-fail disabled:cursor-not-allowed disabled:text-text-void",
          )}
        >
          {cleaning ? "clearing tests..." : "clear tests"}
        </button>
      </div>

      <PageState
        data={query.data}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        isEmpty={(data) => data.repos.length === 0 && data.runs.length === 0}
        empty={(
          <EmptyState
            title="No memory runs yet"
            description="Runs will appear here after memory executes for a repo or manual test."
          />
        )}
      >
        {(data) => {
          const live = data.runs.filter((run) => run.status === "running");
          const history = data.runs.filter((run) => run.status !== "running");
          const sections = buildRepoSections(data.repos, history);

          return (
            <>
              <SectionDivider
                label="live"
                detail={live.length > 0 ? `${live.length} run${live.length === 1 ? "" : "s"}` : undefined}
              />
              {live.length === 0 ? (
                <p className="py-8 text-center font-mono text-[11px] text-text-ghost">No active memory runs</p>
              ) : (
                <div className="mt-4 space-y-3 stagger">
                  {live.map((run) => (
                    <LiveMemoryRunCard key={run.id} run={run} now={now} onClick={() => openRun(run)} />
                  ))}
                </div>
              )}

              <SectionDivider label="history" className="mt-10" />
              <div className="space-y-6">
                {sections.map((section) => (
                  <div key={section.repo}>
                    <SectionDivider
                      label={section.repo}
                      detail={`${section.runs.length} run${section.runs.length === 1 ? "" : "s"}`}
                    />
                    <div className="mt-3 rounded-lg bg-glass px-4 py-3">
                      <RepoMemorySummary
                        repo={section.repo}
                        status={data.statusByRepo[section.repo]}
                        registered={section.registered}
                        now={now}
                      />
                    </div>
                    <div className="mt-2 space-y-0.5 stagger">
                      {section.runs.length > 0 ? (
                        section.runs.map((run) => (
                          <MemoryRunRow key={run.id} run={run} onClick={() => openRun(run)} />
                        ))
                      ) : (
                        <EmptyState
                          title="No runs for this repo"
                          description="This registered repo has no visible memory history yet."
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </PageState>
    </div>
  );
}

// --- Live card (mirrors LiveTaskCard in Tasks.tsx) ---

const KIND_TONE: Record<MemoryRun["kind"], string> = {
  cold: "text-accent",
  warm: "text-warn",
  skip: "text-text-void",
  noop: "text-text-dim",
};

interface LiveMemoryRunCardProps {
  run: MemoryRun;
  now: number;
  onClick: () => void;
}

function LiveMemoryRunCard({ run, now, onClick }: LiveMemoryRunCardProps) {
  const subtitle = run.externalLabel ?? (run.originTaskId ? `task ${shortId(run.originTaskId)}` : null);

  return (
    <div className="animate-fade-up">
      <Card hoverable live onClick={onClick}>
        <div className="mb-2 flex items-center gap-3">
          <span className={cn("font-mono text-[10px] uppercase tracking-wide", KIND_TONE[run.kind])}>
            {run.kind}
          </span>
          <span className="font-mono text-[11px] font-medium text-accent">{run.repo}</span>
          <StatusBadge status={run.status} />
          <span className="ml-auto font-mono text-[10px] text-text-void">
            {timeAgo(run.startedAt, now)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-text-ghost">
          {run.sha && <span className="text-text-dim">{run.sha.slice(0, 8)}</span>}
          {run.zoneCount !== null && (
            <span>{run.zoneCount} zone{run.zoneCount === 1 ? "" : "s"}</span>
          )}
          {subtitle && <span>{subtitle}</span>}
        </div>
      </Card>
    </div>
  );
}

// --- Helpers ---

interface RepoSection {
  repo: string;
  registered: boolean;
  runs: MemoryRun[];
}

async function loadMemoryPage(filters: {
  hideTests: boolean;
  kind: KindFilter;
}): Promise<MemoryPageData> {
  const [repos, runs] = await Promise.all([
    fetchRepos(),
    fetchMemoryRuns({
      includeTests: !filters.hideTests,
      kind: filters.kind === "all" ? undefined : filters.kind,
    }),
  ]);

  const statuses = await Promise.all(
    repos.map(async (repo) => [repo.name, await fetchMemoryStatus(repo.name)] as const),
  );

  return {
    repos,
    runs,
    statusByRepo: Object.fromEntries(statuses),
  };
}

function buildRepoSections(repos: Repo[], runs: MemoryRun[]): RepoSection[] {
  const runsByRepo = new Map<string, MemoryRun[]>();
  for (const run of runs) {
    const current = runsByRepo.get(run.repo) ?? [];
    runsByRepo.set(run.repo, [...current, run]);
  }

  const registeredRepoNames = repos.map((repo) => repo.name);
  const unregisteredRepoNames = [...runsByRepo.keys()]
    .filter((repo) => !registeredRepoNames.includes(repo))
    .sort();

  return [...registeredRepoNames, ...unregisteredRepoNames].map((repo) => ({
    repo,
    registered: registeredRepoNames.includes(repo),
    runs: runsByRepo.get(repo) ?? [],
  }));
}

interface KindFiltersProps {
  value: KindFilter;
  onChange: (value: KindFilter) => void;
}

function KindFilters({ value, onChange }: KindFiltersProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {KIND_FILTERS.map((filter) => (
        <button
          key={filter}
          onClick={() => onChange(filter)}
          className={cn(
            "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
            value === filter ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
          )}
        >
          {filter}
        </button>
      ))}
    </div>
  );
}

interface RepoMemorySummaryProps {
  repo: string;
  status: MemoryStatus | undefined;
  registered: boolean;
  now: number;
}

function RepoMemorySummary({ repo, status, registered, now }: RepoMemorySummaryProps) {
  if (!registered) {
    return (
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
        <span className="text-text">{repo}</span>
        <span className="rounded-full border border-glass-border px-2 py-0.5 text-text-ghost">
          unregistered
        </span>
        <span className="text-text-void">Historical runs only</span>
      </div>
    );
  }

  if (!status) {
    return <span className="font-mono text-[10px] text-text-ghost">loading memory status...</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
      <span className="text-text-ghost">status</span>
      <span className="text-text">{status.status}</span>
      {status.lastIndexedSha && <span className="text-text-dim">{status.lastIndexedSha.slice(0, 8)}</span>}
      {status.lastIndexedAt && <span className="text-text-ghost">{timeAgo(status.lastIndexedAt, now)}</span>}
      <span className="text-text-void">{status.zones.length} zone{status.zones.length === 1 ? "" : "s"}</span>
      <span className="text-text-void">{status.fileCount} file{status.fileCount === 1 ? "" : "s"}</span>
    </div>
  );
}
