/** Repo-scoped open GitHub PR inbox with Goodboy review actions. */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createPrReview,
  closePrOnGitHub,
  fetchPrInbox,
  fetchRepos,
  reconcilePrSessions,
  retryTask,
  setPrSessionWatchStatus,
  type PrInboxRow,
  type PrSessionReconcileSummary,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useNow } from "@dashboard/hooks/use-now";
import { useTaskDetailsMap } from "@dashboard/hooks/use-task-details-map";
import { EmptyState } from "@dashboard/components/EmptyState";
import { PageState } from "@dashboard/components/PageState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { cn } from "@dashboard/lib/utils";
import {
  PrInboxCard,
  RepoSelect,
  ReconcileNotice,
  GitHubError,
} from "@dashboard/components/pr-inbox";

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
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [closeKey, setCloseKey] = useState<string | null>(null);
  const [watchKey, setWatchKey] = useState<string | null>(null);
  const [reconcileState, setReconcileState] = useState<{
    busy: boolean;
    summary: PrSessionReconcileSummary | null;
  }>({ busy: false, summary: null });

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

  const runningTaskIds = useMemo(
    () => (inboxQuery.data?.rows ?? [])
      .filter((row) => row.state === "review_running" && row.reviewTaskId)
      .map((row) => row.reviewTaskId!),
    [inboxQuery.data],
  );

  const taskDetails = useTaskDetailsMap(runningTaskIds);

  // --- Actions ---

  async function runAction(key: string, action: () => Promise<void>) {
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

  async function handleClose(row: PrInboxRow) {
    const key = `${row.repo}#${row.number}`;
    if (closeKey) return;
    const confirmed = window.confirm(`Close PR #${row.number} "${row.title}" on GitHub?`);
    if (!confirmed) return;
    setCloseKey(key);
    try {
      await closePrOnGitHub(row.repo, row.number);
      inboxQuery.refetch();
    } finally {
      setCloseKey(null);
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

  // --- Render ---

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
                      closing={closeKey === `${row.repo}#${row.number}`}
                      onOpen={() => openRow(row)}
                      onToggleWatch={() => handleToggleWatch(row)}
                      onStart={() => handleStart(row)}
                      onRetry={() => handleRetry(row)}
                      onRerun={() => handleRerun(row)}
                      onClose={() => handleClose(row)}
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

// --- Helpers ---

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
