/** PR review task history page. Telegram submissions only; dashboard is read-only. */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRepos, fetchTask, fetchTasks, type Repo, type Task, type TaskWithStages } from "@dashboard/lib/api";
import { LivePrReviewCard } from "@dashboard/components/pr-reviews/LivePrReviewCard";
import { EmptyState } from "@dashboard/components/EmptyState";
import { PageState } from "@dashboard/components/PageState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { PrReviewRow } from "@dashboard/components/rows/PrReviewRow";
import { useNow } from "@dashboard/hooks/use-now";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { cn } from "@dashboard/lib/utils";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const HISTORY_FILTERS = ["all", "complete", "failed", "cancelled"] as const;
const ALL_REPOS_FILTER = "all";

type HistoryFilter = (typeof HISTORY_FILTERS)[number];

interface PrReviewsPageData {
  repos: Repo[];
  reviews: Task[];
}

export function PrReviews() {
  const navigate = useNavigate();
  const now = useNow();
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [repoFilter, setRepoFilter] = useState<string>(ALL_REPOS_FILTER);
  const [taskDetails, setTaskDetails] = useState<Map<string, TaskWithStages>>(new Map());

  const query = useQuery(loadPrReviewsPage);

  useSSERefresh(query.refetch, (event) => event.type === "task_update");

  const filteredReviews = useMemo(() => {
    const reviews = query.data?.reviews ?? [];
    if (repoFilter === ALL_REPOS_FILTER) return reviews;
    return reviews.filter((task) => task.repo === repoFilter);
  }, [query.data?.reviews, repoFilter]);

  const activeIds = filteredReviews
    .filter((task) => ACTIVE_STATUSES.has(task.status))
    .map((task) => task.id)
    .join(",");

  useEffect(() => {
    if (!activeIds) return;
    const ids = activeIds.split(",");
    for (const id of ids) {
      if (!taskDetails.has(id)) {
        fetchTask(id).then((detail) => {
          setTaskDetails((prev) => new Map(prev).set(id, detail));
        });
      }
    }
  }, [activeIds, taskDetails]);

  useSSE((event) => {
    if (event.type !== "task_update" && event.type !== "stage_update") return;
    if (!filteredReviews.some((task) => task.id === event.taskId)) return;
    fetchTask(event.taskId).then((detail) => {
      setTaskDetails((prev) => new Map(prev).set(event.taskId, detail));
    });
  });

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">PR Reviews</h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          PR review tasks submitted through Telegram by sending a PR link and asking for review
        </p>
      </header>

      <PageState
        data={query.data}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
        isEmpty={(data) => data.reviews.length === 0}
        empty={(
          <EmptyState
            title="No PR reviews yet"
            description="Send a PR link on Telegram and ask goodboy to review it."
          />
        )}
      >
        {(data) => {
          const repoFilters = buildRepoFilters(data.repos, data.reviews);
          const live = filteredReviews.filter((task) => ACTIVE_STATUSES.has(task.status));
          const history = filteredReviews.filter((task) => !ACTIVE_STATUSES.has(task.status));
          const filteredHistory = historyFilter === "all"
            ? history
            : history.filter((task) => task.status === historyFilter);
          const historyCounts = countByStatus(history);

          return (
            <>
              <div className="mb-6 flex flex-wrap items-center gap-2">
                <RepoFilters value={repoFilter} onChange={setRepoFilter} repos={repoFilters} />
              </div>

              <section className="mb-10">
                <SectionDivider
                  label="live"
                  detail={live.length > 0 ? `${live.length} review${live.length === 1 ? "" : "s"}` : undefined}
                />
                {live.length === 0 ? (
                  <p className="py-6 text-center font-mono text-[10px] text-text-void">No active PR reviews</p>
                ) : (
                  <div className="mt-4 space-y-3 stagger">
                    {live.map((task) => (
                      <LivePrReviewCard
                        key={task.id}
                        task={task}
                        detail={taskDetails.get(task.id)}
                        now={now}
                        onClick={() => navigate(`/tasks/${task.id}`)}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section>
                <SectionDivider
                  label="history"
                  detail={`${history.length} review${history.length === 1 ? "" : "s"}`}
                />
                <HistoryFilterTabs value={historyFilter} onChange={setHistoryFilter} counts={historyCounts} />

                {filteredHistory.length === 0 ? (
                  <p className="py-6 text-center font-mono text-[10px] text-text-void">
                    No {historyFilter === "all" ? "completed" : historyFilter} PR reviews
                  </p>
                ) : (
                  <div className="mt-2 space-y-0.5 stagger">
                    {filteredHistory.map((task) => (
                      <PrReviewRow key={task.id} task={task} onClick={() => navigate(`/tasks/${task.id}`)} />
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

async function loadPrReviewsPage(): Promise<PrReviewsPageData> {
  const [repos, reviews] = await Promise.all([
    fetchRepos(),
    fetchTasks({ kind: "pr_review" }),
  ]);

  return { repos, reviews };
}

function buildRepoFilters(repos: Repo[], reviews: Task[]): string[] {
  const registered = repos.map((repo) => repo.name);
  const unregistered = [...new Set(reviews.map((task) => task.repo))]
    .filter((repo) => !registered.includes(repo))
    .sort();
  return [ALL_REPOS_FILTER, ...registered, ...unregistered];
}

function countByStatus(tasks: Task[]): Record<HistoryFilter, number> {
  const counts: Record<HistoryFilter, number> = { all: tasks.length, complete: 0, failed: 0, cancelled: 0 };
  for (const task of tasks) {
    if (task.status in counts) counts[task.status as HistoryFilter]++;
  }
  return counts;
}

interface RepoFiltersProps {
  value: string;
  onChange: (value: string) => void;
  repos: string[];
}

function RepoFilters({ value, onChange, repos }: RepoFiltersProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {repos.map((repo) => (
        <button
          key={repo}
          onClick={() => onChange(repo)}
          className={cn(
            "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
            value === repo ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
          )}
        >
          {repo}
        </button>
      ))}
    </div>
  );
}

interface HistoryFilterTabsProps {
  value: HistoryFilter;
  onChange: (value: HistoryFilter) => void;
  counts: Record<HistoryFilter, number>;
}

function HistoryFilterTabs({ value, onChange, counts }: HistoryFilterTabsProps) {
  return (
    <div className="mt-3 mb-4 flex gap-1">
      {HISTORY_FILTERS.map((filter) => (
        <button
          key={filter}
          onClick={() => onChange(filter)}
          className={cn(
            "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
            value === filter ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
          )}
        >
          {filter}
          <span className="ml-1.5 text-text-void">{counts[filter]}</span>
        </button>
      ))}
    </div>
  );
}
