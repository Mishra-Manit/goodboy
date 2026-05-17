/** Task detail: header, pipeline viz, per-stage session transcript, artifacts. */

import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  cancelTask,
  fetchPrSessionBySourceTask,
  fetchTask,
  fetchTaskArtifacts,
  fetchTaskSession,
  fetchTaskSessionSummary,
  retryTask,
  TASK_KIND_CONFIG,
  type AgentSessionDto,
  type FileEntry,
  type TaskArtifactDto,
  type TaskWithStages,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useLiveSession } from "@dashboard/hooks/use-live-session";
import { useNow } from "@dashboard/hooks/use-now";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { TaskHeader } from "@dashboard/components/tasks/TaskHeader";
import { ArtifactsPanel } from "@dashboard/components/tasks/ArtifactsPanel";
import { AgentSessionSummary } from "@dashboard/components/tasks/AgentSessionSummary";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { LogViewer } from "@dashboard/components/log-viewer";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { dedupeById } from "@dashboard/components/log-viewer/helpers";
import { getPrReviewTarget, getPrReviewUrl } from "@dashboard/lib/pr-review";
import { buildStageTabs, stageSessionKey, type StageSessionLike } from "@dashboard/lib/stage-tabs";
import { cn, shortId } from "@dashboard/lib/utils";
import { ErrorBlock } from "@dashboard/components/ErrorBlock";
import { ArrowUpRight } from "lucide-react";
import { isTerminalStatus } from "@dashboard/shared";

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/" replace />;
  const taskId = id;

  const navigate = useNavigate();
  const now = useNow();

  const { data: task, loading, error, refetch } = useQuery(`task:${taskId}`, () => fetchTask(taskId));
  const { data: sessionData, refetch: refetchSession } = useQuery(
    `task-session:${taskId}`,
    () => fetchTaskSession(taskId),
  );
  const { data: dbArtifacts, refetch: refetchArtifacts } = useQuery(
    `task-artifacts:${taskId}`,
    () => fetchTaskArtifacts(taskId),
  );
  const { data: sessionSummary, refetch: refetchSessionSummary } = useQuery(
    `task-session-summary:${taskId}`,
    () => fetchTaskSessionSummary(taskId),
  );

  useSSERefresh(
    () => {
      refetch();
      refetchSession();
      refetchArtifacts();
      refetchSessionSummary();
    },
    (e) => (e.type === "task_update" || e.type === "stage_update") && e.taskId === taskId,
  );

  const liveEntries = useLiveSession({
    match: (event) =>
      event.type === "session_entry" && event.scope === "task" && event.id === taskId && event.stage
        ? { key: stageSessionKey(event.stage, event.variant), entry: event.entry }
        : null,
  });

  return (
    <div className="animate-fade-in">
      <BackLink label="back" onClick={() => navigate(-1)} />
      <PageState data={task} loading={loading} error={error} onRetry={refetch} loadingLabel="loading task...">
        {(task) => (
          <TaskView
            task={task}
            diskEntries={sessionData?.stages ?? []}
            liveEntries={liveEntries}
            now={now}
            refetch={refetch}
            taskId={taskId}
            dbArtifacts={dbArtifacts ?? []}
            sessionSummary={sessionSummary?.sessions ?? []}
          />
        )}
      </PageState>
    </div>
  );
}

// --- Main view ---

interface TaskViewProps {
  task: TaskWithStages;
  diskEntries: StageSessionLike[];
  liveEntries: Map<string, FileEntry[]>;
  now: number;
  refetch: () => void;
  taskId: string;
  dbArtifacts: readonly TaskArtifactDto[];
  sessionSummary: readonly AgentSessionDto[];
}

function TaskView({
  task,
  diskEntries,
  liveEntries,
  now,
  refetch,
  taskId,
  dbArtifacts,
  sessionSummary,
}: TaskViewProps) {
  const navigate = useNavigate();
  const kindConfig = TASK_KIND_CONFIG[task.kind] ?? TASK_KIND_CONFIG.coding_task;
  const isActive = !isTerminalStatus(task.status);
  const prReviewUrl = getPrReviewUrl(task);
  const prReviewTarget = getPrReviewTarget(task);

  // Page owns the linked-session fetch so the banner stays a pure component.
  // Skip the request unless this is a pr_review task.
  const { data: prSession } = useQuery(
    `task-pr-session:${task.id}:${task.kind}`,
    () => (task.kind === "pr_review" ? fetchPrSessionBySourceTask(task.id) : Promise.resolve(null)),
  );

  const tabs = useMemo(
    () => buildStageTabs(task.stages, diskEntries, liveEntries, kindConfig.stages),
    [task.stages, diskEntries, liveEntries, kindConfig.stages],
  );

  const artifacts = useMemo(() => {
    if (dbArtifacts.length === 0) return kindConfig.artifacts;
    return dbArtifacts.map((artifact) => ({
      key: artifact.filePath,
      label: kindConfig.artifacts.find((item) => item.key === artifact.filePath)?.label ?? artifact.filePath,
    }));
  }, [dbArtifacts, kindConfig.artifacts]);

  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => {
    if (activeStage && tabs.some((tab) => tab.key === activeStage)) return;
    const running = tabs.find((tab) => tab.stage?.status === "running")?.key;
    setActiveStage(running ?? tabs[tabs.length - 1]?.key ?? null);
  }, [tabs, activeStage]);

  const entriesForStage = (key: string): FileEntry[] => {
    if (!tabs.some((tab) => tab.key === key)) return [];
    return dedupeById([
      ...(diskEntries.find((entry) => stageSessionKey(entry.stage, entry.variant) === key)?.entries ?? []),
      ...(liveEntries.get(key) ?? []),
    ]);
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const result = await retryTask(task.id);
      navigate(`/tasks/${result.task.id}`);
    } catch {
      refetch();
      setRetrying(false);
    }
  };
  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelTask(task.id);
      refetch();
    } catch {
      refetch();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <TaskHeader
        task={task}
        now={now}
        isActive={isActive}
        retrying={retrying}
        cancelling={cancelling}
        onRetry={handleRetry}
        onCancel={handleCancel}
      />

      {task.error && <ErrorBlock message={task.error} />}

      {kindConfig.stages.length > 1 && (
        <div className="mb-8 flex justify-center py-4">
          <PipelineProgress stages={task.stages} kind={task.kind} />
        </div>
      )}

      {task.kind === "pr_review" && task.prIdentifier && (
        <PrReviewBanner
          prReviewUrl={prReviewUrl}
          prReviewTarget={prReviewTarget}
          linkedSession={prSession}
          canViewReview={task.status === "complete"}
          onReviewClick={() => navigate(`/tasks/${task.id}/review`)}
          onSessionClick={() => prSession && navigate(`/prs/${prSession.id}`)}
        />
      )}

      <SectionDivider label="agent metrics" />
      <AgentSessionSummary sessions={sessionSummary} />

      <SectionDivider label="transcript" />

      {tabs.length > 0 && (
        <div role="tablist" className="mt-3 mb-3 flex flex-wrap gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeStage === tab.key}
              onClick={() => setActiveStage(tab.key)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px]",
                "transition-all duration-200",
                activeStage === tab.key ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
              )}
            >
              {tab.label}
              {tab.stage && <StatusBadge status={tab.stage.status} className="text-[8px]" />}
            </button>
          ))}
        </div>
      )}

      {activeStage ? (
        <div role="tabpanel" aria-label={activeStage}>
          <LogViewer entries={entriesForStage(activeStage)} maxHeight="500px" autoScroll={isActive} />
        </div>
      ) : (
        <p className="font-mono text-xs text-text-void py-4">no stages recorded yet</p>
      )}

      <SectionDivider label="artifacts" className="mt-8" />
      <ArtifactsPanel taskId={taskId} artifacts={artifacts} />
    </>
  );
}

// --- Helpers ---

export interface PrReviewBannerProps {
  prReviewUrl: string | null;
  prReviewTarget: string;
  linkedSession: { id: string } | null;
  canViewReview: boolean;
  onReviewClick: () => void;
  onSessionClick: () => void;
}

/** Inline header strip for `pr_review` tasks: target + optional session link. */
function PrReviewBanner({
  prReviewUrl,
  prReviewTarget,
  linkedSession,
  canViewReview,
  onReviewClick,
  onSessionClick,
}: PrReviewBannerProps) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-text-ghost">
      <span>
        reviewing:{" "}
        {prReviewUrl ? (
          <a
            href={prReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-ghost transition-colors hover:text-accent"
          >
            {prReviewTarget}
          </a>
        ) : (
          prReviewTarget
        )}
      </span>
      {canViewReview && (
        <button
          type="button"
          onClick={onReviewClick}
          className="flex items-center gap-1 text-accent transition-colors hover:underline"
        >
          view review
          <ArrowUpRight size={9} />
        </button>
      )}
      {linkedSession && (
        <button
          type="button"
          onClick={onSessionClick}
          className="flex items-center gap-1 text-text-ghost transition-colors hover:text-accent hover:underline"
        >
          PR session ({shortId(linkedSession.id)})
          <ArrowUpRight size={9} />
        </button>
      )}
    </div>
  );
}
