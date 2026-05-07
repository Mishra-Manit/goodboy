/** Tasks home: live tasks up top, history grouped by date below. */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchTasks, type Task } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useNow } from "@dashboard/hooks/use-now";
import { useTaskDetailsMap } from "@dashboard/hooks/use-task-details-map";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { Card } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { TaskRow } from "@dashboard/components/rows/TaskRow";
import { PageState } from "@dashboard/components/PageState";
import { FilterPillGroup } from "@dashboard/components/FilterPillGroup";
import { groupByDate } from "@dashboard/lib/task-grouping";
import { shortId } from "@dashboard/lib/utils";
import { timeAgo } from "@dashboard/lib/format";
import { isTerminalStatus } from "@dashboard/shared";

const HISTORY_FILTERS = ["all", "complete", "failed", "cancelled"] as const;
type HistoryFilter = (typeof HISTORY_FILTERS)[number];

export function Tasks() {
  const navigate = useNavigate();
  const now = useNow();

  const query = useQuery("tasks", fetchTasks);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");

  useSSERefresh(query.refetch, (e) => e.type === "task_update");

  const activeIds = useMemo(
    () => (query.data ?? []).filter((t) => !isTerminalStatus(t.status)).map((t) => t.id),
    [query.data],
  );

  const taskDetails = useTaskDetailsMap(activeIds);

  return (
    <div>
      <header className="mb-10 text-center">
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">goodboy</h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost tracking-wide">
          background coding agent
        </p>
      </header>

      <PageState data={query.data} loading={query.loading} error={query.error} onRetry={query.refetch}>
        {(tasks) => {
          const active = tasks.filter((t) => !isTerminalStatus(t.status));
          const completed = tasks.filter((t) => isTerminalStatus(t.status));
          const historyCounts = countByStatus(completed);
          const filteredHistory = historyFilter === "all"
            ? completed
            : completed.filter((t) => t.status === historyFilter);

          return (
            <>
              <SectionDivider
                label="live"
                detail={active.length > 0 ? `${active.length} task${active.length === 1 ? "" : "s"}` : undefined}
              />

              {active.length === 0 ? (
                <p className="py-8 text-center font-mono text-[11px] text-text-ghost">No active tasks</p>
              ) : (
                <div className="mt-4 space-y-3 stagger">
                  {active.map((task) => (
                    <LiveTaskCard
                      key={task.id}
                      task={task}
                      detail={taskDetails.get(task.id)}
                      now={now}
                      onClick={() => navigate(`/tasks/${task.id}`)}
                    />
                  ))}
                </div>
              )}

              <SectionDivider label="history" className="mt-10" />
              <div className="mt-3 mb-4">
                <FilterPillGroup
                  filters={HISTORY_FILTERS}
                  value={historyFilter}
                  onChange={setHistoryFilter}
                  counts={historyCounts}
                />
              </div>

              {filteredHistory.length === 0 ? (
                <EmptyState
                  title="No tasks found"
                  description={
                    historyFilter === "all"
                      ? "Tasks will appear here after they finish"
                      : `No ${historyFilter} tasks`
                  }
                />
              ) : (
                <div className="space-y-6">
                  {groupByDate(filteredHistory).map(({ label, tasks: dateTasks }) => (
                    <div key={label}>
                      <SectionDivider label={label} detail={`${dateTasks.length}`} />
                      <div className="mt-2 space-y-0.5 stagger">
                        {dateTasks.map((task) => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            showDuration
                            onClick={() => navigate(`/tasks/${task.id}`)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          );
        }}
      </PageState>
    </div>
  );
}

// --- Helpers ---

function countByStatus(tasks: Task[]): Partial<Record<HistoryFilter, number>> {
  const counts: Record<HistoryFilter, number> = { all: tasks.length, complete: 0, failed: 0, cancelled: 0 };
  for (const t of tasks) {
    if (t.status in counts) counts[t.status as HistoryFilter]++;
  }
  return counts;
}

// --- Components ---

interface LiveTaskCardProps {
  task: Task;
  detail: import("@dashboard/lib/api").TaskWithStages | undefined;
  now: number;
  onClick: () => void;
}

function LiveTaskCard({ task, detail, now, onClick }: LiveTaskCardProps) {
  return (
    <div className="animate-fade-up">
      <Card hoverable live onClick={onClick}>
        <div className="flex items-center gap-3 mb-2">
          <code className="font-mono text-[10px] text-text-ghost">{shortId(task.id)}</code>
          <span className="font-mono text-[11px] font-medium text-accent">{task.repo}</span>
          <StatusBadge status={task.status} />
          <span className="ml-auto font-mono text-[10px] text-text-void">
            {timeAgo(task.createdAt, now)}
          </span>
        </div>

        <p className="text-[13px] text-text-secondary leading-relaxed line-clamp-2">{task.description}</p>

        {detail && task.kind === "coding_task" && (
          <div className="mt-3 flex items-center justify-between">
            <PipelineProgress stages={detail.stages} kind={task.kind} className="hidden sm:flex" />
            <PipelineProgress stages={detail.stages} kind={task.kind} mini className="flex sm:hidden" />
          </div>
        )}
      </Card>
    </div>
  );
}
