/** Memory run history page. Repo summary grid, live runs, then a flat chronological history list. */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  deleteMemoryRepo,
  deleteMemoryTests,
  fetchMemoryRuns,
  fetchMemoryStatus,
  fetchRepos,
  type MemoryRun,
  type MemoryStatus,
  type Repo,
} from "@dashboard/lib/api";
import { MEMORY_RUN_KINDS } from "@dashboard/shared";
import { PageState } from "@dashboard/components/PageState";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { MemoryRunRow } from "@dashboard/components/rows/MemoryRunRow";
import { LiveMemoryRunCard } from "@dashboard/components/memory/LiveMemoryRunCard";
import { RepoSummaryCard, type RepoEntry } from "@dashboard/components/memory/RepoSummaryCard";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useNow } from "@dashboard/hooks/use-now";
import { cn } from "@dashboard/lib/utils";

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
  const [deletingRepo, setDeletingRepo] = useState<string | null>(null);

  const query = useQuery(
    `memory:${hideTests}:${kind}:${runsVersion}`,
    () => loadMemoryPage({ hideTests, kind }),
  );

  useSSERefresh(query.refetch, (event) => event.type === "memory_run_update");

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

  async function handleDeleteRepo(repo: string): Promise<void> {
    const confirmed = window.confirm(
      `Completely delete memory for ${repo}?\n\nThis removes the memory checkout, all saved memory files, and hides prior memory runs for this repo. The next memory build will be a cold start.`,
    );
    if (!confirmed) return;

    setDeletingRepo(repo);
    try {
      await deleteMemoryRepo(repo);
      setRunsVersion((value) => value + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("API 409")) {
        window.alert("Memory delete is blocked because a memory run is currently active for this repo.");
        return;
      }
      window.alert(message);
    } finally {
      setDeletingRepo((current) => (current === repo ? null : current));
    }
  }

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">Memory</h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          cold, warm, skip, and noop memory runs across all visible repos
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <KindFilters value={kind} onChange={setKind} />
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setHideTests((value) => !value)}
            className={cn(
              "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
              hideTests
                ? "border border-glass-border text-text-ghost hover:text-text-dim"
                : "bg-glass text-text",
            )}
          >
            {hideTests ? "tests hidden" : "tests shown"}
          </button>
          <button
            onClick={() => void handleCleanTests()}
            disabled={cleaning}
            className="rounded-full px-3 py-1 font-mono text-[10px] tracking-wide text-text-ghost transition-colors hover:text-fail disabled:cursor-not-allowed disabled:text-text-void"
          >
            {cleaning ? "clearing..." : "clear tests"}
          </button>
        </div>
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
          const runCounts = countRunsByRepo(data.runs);
          const repoEntries = buildRepoEntries(data.repos, data.runs, data.statusByRepo, runCounts);

          return (
            <>
              {repoEntries.length > 0 && (
                <section className="mb-10">
                  <SectionDivider label="repos" detail={`${repoEntries.length}`} />
                  <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {repoEntries.map((entry) => (
                      <RepoSummaryCard
                        key={entry.repo}
                        entry={entry}
                        now={now}
                        deleting={deletingRepo === entry.repo}
                        onDelete={handleDeleteRepo}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="mb-10">
                <SectionDivider
                  label="live"
                  detail={live.length > 0 ? `${live.length} run${live.length === 1 ? "" : "s"}` : undefined}
                />
                {live.length === 0 ? (
                  <p className="py-6 text-center font-mono text-[10px] text-text-void">
                    No active memory runs
                  </p>
                ) : (
                  <div className="mt-4 space-y-3 stagger">
                    {live.map((run) => (
                      <LiveMemoryRunCard key={run.id} run={run} now={now} onClick={() => openRun(run)} />
                    ))}
                  </div>
                )}
              </section>

              <section>
                <SectionDivider
                  label="history"
                  detail={`${history.length} run${history.length === 1 ? "" : "s"}`}
                />
                {history.length === 0 ? (
                  <p className="py-6 text-center font-mono text-[10px] text-text-void">
                    No completed memory runs yet
                  </p>
                ) : (
                  <div className="mt-2 space-y-0.5 stagger">
                    {history.map((run) => (
                      <MemoryRunRow key={run.id} run={run} onClick={() => openRun(run)} showRepo />
                    ))}
                  </div>
                )}
              </section>
            </>
          );
        }}
      </PageState>
    </div>
  );
}

// --- Helpers ---

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

function countRunsByRepo(runs: MemoryRun[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const run of runs) {
    counts.set(run.repo, (counts.get(run.repo) ?? 0) + 1);
  }
  return counts;
}

function buildRepoEntries(
  repos: Repo[],
  runs: MemoryRun[],
  statusByRepo: Record<string, MemoryStatus>,
  runCounts: Map<string, number>,
): RepoEntry[] {
  const registeredNames = repos.map((repo) => repo.name);
  const unregisteredNames = [...new Set(runs.map((run) => run.repo))]
    .filter((repo) => !registeredNames.includes(repo))
    .sort();

  const registered = registeredNames.map((repo) => ({
    repo,
    registered: true,
    status: statusByRepo[repo],
    runCount: runCounts.get(repo) ?? 0,
  }));

  const unregistered = unregisteredNames.map((repo) => ({
    repo,
    registered: false,
    status: undefined,
    runCount: runCounts.get(repo) ?? 0,
  }));

  return [...registered, ...unregistered];
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
