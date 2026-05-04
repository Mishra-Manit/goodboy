/** Repo-scoped open GitHub PR inbox with Goodboy review actions. */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  createPrReview,
  fetchPrInbox,
  fetchRepos,
  fetchTask,
  reconcilePrSessions,
  retryTask,
  setPrSessionWatchStatus,
  type PrInboxRow,
  type PrSessionReconcileSummary,
  type TaskWithStages,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { useNow } from "@dashboard/hooks/use-now";
import { Card } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";
import { PageState } from "@dashboard/components/PageState";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { cn, shortId } from "@dashboard/lib/utils";
import { timeAgo } from "@dashboard/lib/format";

const SELECTED_REPO_STORAGE_KEY = "goodboy.prs.selectedRepo";

export function PullRequests() {
  const navigate = useNavigate();
  const now = useNow();
  const reposQuery = useQuery("repos", fetchRepos);
  const githubRepos = useMemo(
    () => (reposQuery.data ?? []).filter((repo) => repo.githubUrl),
    [reposQuery.data],
  );
  const [repo, setRepo] = useState<string | null>(() => loadSelectedRepo());
  const [taskDetails, setTaskDetails] = useState<Map<string, TaskWithStages>>(new Map());
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [watchKey, setWatchKey] = useState<string | null>(null);
  const [reconcileState, setReconcileState] = useState<{
    busy: boolean;
    summary: PrSessionReconcileSummary | null;
  }>({ busy: false, summary: null });

  // Restore the last selected repo when possible; fall back if the registry changed.
  useEffect(() => {
    if (githubRepos.length === 0) return;
    if (repo && githubRepos.some((item) => item.name === repo)) return;
    selectRepo(githubRepos[0].name);
  }, [repo, githubRepos]);

  const inboxQuery = useQuery(
    repo ? `pr-inbox:${repo}` : "pr-inbox:none",
    () => repo ? fetchPrInbox(repo) : Promise.resolve({ rows: [], githubError: null }),
  );

  useSSERefresh(inboxQuery.refetch, (event) => (
    event.type === "task_update" || event.type === "pr_session_update"
  ));

  // Running rows need full task details so the shared pipeline progress can render stages.
  const runningTaskIds = useMemo(
    () => (inboxQuery.data?.rows ?? [])
      .filter((row) => row.state === "review_running" && row.reviewTaskId)
      .map((row) => row.reviewTaskId!),
    [inboxQuery.data],
  );

  useEffect(() => {
    const missingIds = runningTaskIds.filter((id) => !taskDetails.has(id));
    if (missingIds.length === 0) return;

    let cancelled = false;
    void Promise.all(missingIds.map((id) => fetchTask(id))).then((details) => {
      if (cancelled) return;
      setTaskDetails((prev) =>
        details.reduce((next, detail) => new Map(next).set(detail.id, detail), prev),
      );
    });

    return () => {
      cancelled = true;
    };
  }, [runningTaskIds, taskDetails]);

  useSSE((event) => {
    if (event.type !== "stage_update" && event.type !== "task_update") return;
    if (!runningTaskIds.includes(event.taskId)) return;
    fetchTask(event.taskId).then((detail) =>
      setTaskDetails((prev) => new Map(prev).set(event.taskId, detail)),
    );
  });

  async function runAction(key: string, action: () => Promise<void>) {
    // One active row action at a time keeps duplicate start/retry clicks from racing.
    if (actionKey) return;
    setActionKey(key);
    try {
      await action();
      inboxQuery.refetch();
    } finally {
      setActionKey(null);
    }
  }

  function handleStart(row: PrInboxRow) {
    return runAction(`${row.repo}#${row.number}:start`, () => (
      createPrReview({ repo: row.repo, prNumber: row.number }).then(() => undefined)
    ));
  }

  function handleRerun(row: PrInboxRow) {
    return runAction(`${row.repo}#${row.number}:rerun`, () => (
      createPrReview({ repo: row.repo, prNumber: row.number, replaceExisting: true }).then(() => undefined)
    ));
  }

  function handleRetry(row: PrInboxRow) {
    if (!row.reviewTaskId) return Promise.resolve();
    return runAction(`${row.repo}#${row.number}:retry`, () => retryTask(row.reviewTaskId!).then(() => undefined));
  }

  async function handleToggleWatch(row: PrInboxRow) {
    if (!row.watchSessionId || !row.watchStatus || watchKey) return;
    setWatchKey(row.watchSessionId);
    try {
      await setPrSessionWatchStatus(row.watchSessionId, row.watchStatus === "muted" ? "watching" : "muted");
      inboxQuery.refetch();
    } finally {
      setWatchKey(null);
    }
  }

  async function handleReconcile() {
    if (reconcileState.busy) return;
    setReconcileState((prev) => ({ ...prev, busy: true }));
    try {
      const preview = await reconcilePrSessions(false);
      const repairs = preview.wouldRecreate + preview.wouldMute;
      if (repairs === 0) {
        setReconcileState({ busy: false, summary: preview });
        return;
      }

      const confirmed = window.confirm(
        `Repair ${repairs} PR session${repairs === 1 ? "" : "s"}? Missing worktrees will be recreated; unrecoverable sessions will be muted.`,
      );
      const summary = confirmed ? await reconcilePrSessions(true) : preview;
      if (confirmed) inboxQuery.refetch();
      setReconcileState({ busy: false, summary });
    } catch {
      setReconcileState({ busy: false, summary: null });
    }
  }

  function selectRepo(next: string | null) {
    setRepo(next);
    saveSelectedRepo(next);
  }

  function openRow(row: PrInboxRow) {
    if (row.openTarget.type === "task") return navigate(`/tasks/${row.openTarget.taskId}`);
    if (row.openTarget.type === "pr_session") return navigate(`/prs/${row.openTarget.sessionId}`);
    window.open(row.openTarget.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div>
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight text-text">Pull Requests</h1>
          <p className="mt-1 font-mono text-[11px] text-text-ghost">
            Open GitHub PRs ready for Goodboy review
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RepoSelect
            value={repo ?? ""}
            repos={githubRepos.map((item) => item.name)}
            onChange={(next) => selectRepo(next || null)}
          />
          <button
            type="button"
            disabled={reconcileState.busy}
            onClick={handleReconcile}
            className={cn(
              "h-8 rounded-full border border-glass-border bg-glass px-3 font-mono text-[10px] tracking-wide transition-colors",
              reconcileState.busy ? "cursor-wait text-text-void" : "text-text-ghost hover:border-glass-hover hover:text-accent",
            )}
          >
            {reconcileState.busy ? "checking..." : "reconcile"}
          </button>
          <button
            type="button"
            onClick={inboxQuery.refetch}
            className="h-8 rounded-full border border-glass-border bg-glass px-3 font-mono text-[10px] tracking-wide text-text-ghost transition-colors hover:border-glass-hover hover:text-accent"
          >
            refresh
          </button>
        </div>
      </header>

      {reconcileState.summary && <ReconcileNotice summary={reconcileState.summary} />}

      <PageState
        data={reposQuery.data}
        loading={reposQuery.loading}
        error={reposQuery.error}
        onRetry={reposQuery.refetch}
        isEmpty={() => githubRepos.length === 0}
        empty={<EmptyState title="No GitHub repos" description="Add githubUrl to a registered repo to discover PRs." />}
      >
        {() => (
          <PageState
            data={inboxQuery.data}
            loading={inboxQuery.loading}
            error={inboxQuery.error}
            onRetry={inboxQuery.refetch}
            isEmpty={(data) => data.rows.length === 0 && !data.githubError}
            empty={<EmptyState title="No open PRs" description="This repo has no open GitHub pull requests." />}
          >
            {(data) => (
              <>
                {data.githubError && <GitHubError message={data.githubError} />}
                <SectionDivider
                  label={repo ?? "prs"}
                  detail={`${data.rows.length} open`}
                  className={data.githubError ? "mt-6" : undefined}
                />
                <div className="mt-3 space-y-3 stagger">
                  {data.rows.map((row) => (
                    <PrInboxCard
                      key={`${row.repo}#${row.number}`}
                      row={row}
                      now={now}
                      detail={row.reviewTaskId ? taskDetails.get(row.reviewTaskId) : undefined}
                      actionKey={actionKey}
                      watchUpdating={watchKey === row.watchSessionId}
                      onOpen={() => openRow(row)}
                      onToggleWatch={() => handleToggleWatch(row)}
                      onStart={() => handleStart(row)}
                      onRetry={() => handleRetry(row)}
                      onRerun={() => handleRerun(row)}
                    />
                  ))}
                </div>
              </>
            )}
          </PageState>
        )}
      </PageState>
    </div>
  );
}

// --- Components ---

interface ReconcileNoticeProps {
  summary: PrSessionReconcileSummary;
}

function ReconcileNotice({ summary }: ReconcileNoticeProps) {
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

interface RepoSelectProps {
  value: string;
  repos: readonly string[];
  onChange: (repo: string) => void;
}

function RepoSelect({ value, repos, onChange }: RepoSelectProps) {
  return (
    <label className="group relative inline-flex items-center">
      <span className="sr-only">Repository</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-8 min-w-36 appearance-none rounded-full border border-glass-border bg-glass",
          "px-3 pr-9 font-mono text-[11px] tracking-wide text-text outline-none",
          "transition-colors hover:border-glass-hover focus:border-accent/60",
        )}
      >
        {repos.map((repo) => (
          <option key={repo} value={repo} className="bg-bg text-text">{repo}</option>
        ))}
      </select>
      <span
        aria-hidden
        className="pointer-events-none absolute right-3 h-1.5 w-1.5 rotate-45 border-b border-r border-text-ghost transition-colors group-hover:border-text-dim"
      />
    </label>
  );
}

interface PrInboxCardProps {
  row: PrInboxRow;
  now: number;
  detail: TaskWithStages | undefined;
  actionKey: string | null;
  watchUpdating: boolean;
  onOpen: () => void;
  onToggleWatch: () => Promise<void>;
  onStart: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRerun: () => Promise<void>;
}

/** Compact PR row; all state decisions arrive precomputed from the API. */
function PrInboxCard({
  row,
  now,
  detail,
  actionKey,
  watchUpdating,
  onOpen,
  onToggleWatch,
  onStart,
  onRetry,
  onRerun,
}: PrInboxCardProps) {
  const activeAction = actionKey?.startsWith(`${row.repo}#${row.number}:`) ?? false;

  return (
    <Card live={row.state === "review_running"} className="animate-fade-up">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-text-ghost">#{row.number}</span>
            <PrStateBadge state={row.state} />
            {row.isDraft && <TinyBadge tone="warn">draft</TinyBadge>}
            {row.reviewDecision && <TinyBadge>{row.reviewDecision.toLowerCase()}</TinyBadge>}
            <span className="font-mono text-[10px] text-text-void">{timeAgo(row.updatedAt, now)}</span>
            <WatchButton row={row} updating={watchUpdating} onToggle={onToggleWatch} />
          </div>
          <button type="button" onClick={onOpen} className="mt-2 block min-w-0 text-left">
            <span className="line-clamp-2 text-[13px] leading-relaxed text-text-secondary transition-colors hover:text-text">
              {row.title}
            </span>
            <span className="mt-1 block font-mono text-[10px] text-text-ghost">
              {row.author} · {row.headRef} → {row.baseRef}
            </span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {renderAction(row, activeAction, onStart, onRetry, onRerun)}
        </div>
      </div>

      {row.labels.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {row.labels.map((label) => <TinyBadge key={label}>{label}</TinyBadge>)}
        </div>
      )}

      {detail && row.state === "review_running" && (
        <div className="mt-4 flex items-center justify-between">
          <code className="font-mono text-[10px] text-text-ghost">{shortId(detail.id)}</code>
          <PipelineProgress stages={detail.stages} kind={detail.kind} className="hidden sm:flex" />
          <PipelineProgress stages={detail.stages} kind={detail.kind} mini className="flex sm:hidden" />
        </div>
      )}
    </Card>
  );
}

/** Pick the single safe action for the row's current state. */
function renderAction(
  row: PrInboxRow,
  active: boolean,
  onStart: () => Promise<void>,
  onRetry: () => Promise<void>,
  onRerun: () => Promise<void>,
): ReactNode {
  if (row.canRetryReview) return <ActionButton busy={active} onClick={onRetry}>Retry review</ActionButton>;
  if (row.canRerunReview) return <ActionButton busy={active} onClick={onRerun}>Re-run review</ActionButton>;
  if (row.canStartReview) {
    return <ActionButton busy={active} onClick={onStart}>{row.state === "owned" ? "Review owned PR" : "Start review"}</ActionButton>;
  }
  return null;
}

interface WatchButtonProps {
  row: PrInboxRow;
  updating: boolean;
  onToggle: () => Promise<void>;
}

function WatchButton({ row, updating, onToggle }: WatchButtonProps) {
  if (!row.watchSessionId || !row.watchStatus) return null;
  const watching = row.watchStatus === "watching";

  return (
    <button
      type="button"
      disabled={updating}
      title={watching ? "Mute PR session" : "Watch PR session"}
      onClick={onToggle}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors",
        updating ? "cursor-wait text-text-void" : "text-text-ghost hover:bg-glass hover:text-accent",
        watching && !updating && "text-accent",
      )}
    >
      <EyeIcon muted={!watching} />
    </button>
  );
}

function EyeIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
      {muted && <path d="M4 20 20 4" />}
    </svg>
  );
}

interface ActionButtonProps {
  busy: boolean;
  onClick: () => Promise<void>;
  children: ReactNode;
}

function ActionButton({ busy, onClick, children }: ActionButtonProps) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={cn(
        "rounded-full border border-glass-border px-3 py-1.5 font-mono text-[10px] transition-colors",
        busy ? "cursor-wait text-text-void" : "text-accent hover:border-accent hover:bg-glass-hover",
      )}
    >
      {busy ? "working..." : children}
    </button>
  );
}

interface TinyBadgeProps {
  children: ReactNode;
  tone?: "neutral" | "warn";
}

function TinyBadge({ children, tone = "neutral" }: TinyBadgeProps) {
  return (
    <span className={cn(
      "rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wide",
      tone === "warn" ? "border-warn/40 text-warn" : "border-glass-border text-text-ghost",
    )}
    >
      {children}
    </span>
  );
}

function PrStateBadge({ state }: { state: PrInboxRow["state"] }) {
  const label: Record<PrInboxRow["state"], string> = {
    not_started: "not started",
    owned: "owned",
    review_running: "review running",
    review_failed: "review failed",
    reviewed: "reviewed",
  };
  const tone: Record<PrInboxRow["state"], string> = {
    not_started: "border-glass-border text-text-ghost",
    owned: "border-accent/40 text-accent",
    review_running: "border-warn/40 text-warn",
    review_failed: "border-fail/40 text-fail",
    reviewed: "border-ok/40 text-ok",
  };

  return (
    <span className={cn("rounded-full border px-2 py-0.5 font-mono text-[9px] tracking-wide", tone[state])}>
      {label[state]}
    </span>
  );
}

function loadSelectedRepo(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SELECTED_REPO_STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSelectedRepo(repo: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (repo) window.localStorage.setItem(SELECTED_REPO_STORAGE_KEY, repo);
    else window.localStorage.removeItem(SELECTED_REPO_STORAGE_KEY);
  } catch {
    /* ignore storage failures */
  }
}

function GitHubError({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-fail/30 bg-glass px-4 py-3">
      <p className="font-mono text-[11px] text-fail">GitHub discovery failed</p>
      <p className="mt-1 font-mono text-[10px] text-text-ghost">{message}</p>
    </div>
  );
}
