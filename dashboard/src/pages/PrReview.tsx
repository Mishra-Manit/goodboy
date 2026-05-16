/** PR review page: natural-language diff layout. Left file rail · center narrative stack · right review thread. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, GitPullRequest } from "lucide-react";
import { fetchTaskPrReviewPage } from "@dashboard/lib/api/tasks";
import { fetchPrReviewPage } from "@dashboard/lib/api/pr-sessions";
import { splitUnifiedDiffByFile } from "@dashboard/lib/diff-patch";
import { formatDate } from "@dashboard/lib/format";
import type {
  PrReviewAnnotation,
  PrReviewRunDto,
  PrReviewSessionDto,
  TaskPrReviewPageDto,
} from "@dashboard/shared";
import { useQuery } from "@dashboard/hooks/use-query";
import { useNavState } from "@dashboard/hooks/use-nav-state";
import { useHideNavOnContainerScroll } from "@dashboard/hooks/use-hide-on-scroll";
import { useViewedFiles } from "@dashboard/hooks/use-viewed-files";
import { PageState } from "@dashboard/components/PageState";
import { FileStack } from "@dashboard/components/pr-review/FileStack";
import { FileTree } from "@dashboard/components/pr-review/FileTree";
import { ResizablePanels } from "@dashboard/components/pr-review/ResizablePanels";
import { ReviewChat } from "@dashboard/components/pr-review/ReviewChat";

export function PrReview() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/prs" replace />;
  return <SessionPrReviewContent sessionId={id} />;
}

export function TaskPrReview() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/" replace />;
  return <TaskPrReviewContent taskId={id} />;
}

// --- Page Loaders ---

interface SessionPrReviewContentProps {
  sessionId: string;
}

function SessionPrReviewContent({ sessionId }: SessionPrReviewContentProps) {
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useQuery(
    `pr-review:${sessionId}`,
    () => fetchPrReviewPage(sessionId),
  );

  return (
    <ReviewPageShell
      data={data ? { session: data.session, task: null, run: data.run } : null}
      loading={loading}
      error={error}
      onRetry={refetch}
      onBack={() => navigate(`/prs/${sessionId}`)}
      onChanged={refetch}
    />
  );
}

interface TaskPrReviewContentProps {
  taskId: string;
}

function TaskPrReviewContent({ taskId }: TaskPrReviewContentProps) {
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useQuery(
    `task-pr-review:${taskId}`,
    () => fetchTaskPrReviewPage(taskId),
  );

  return (
    <ReviewPageShell
      data={data ? { session: data.session, task: data.task, run: data.run } : null}
      loading={loading}
      error={error}
      onRetry={refetch}
      onBack={() => navigate(`/tasks/${taskId}`)}
      onChanged={refetch}
    />
  );
}

// --- Shared Review Page ---

interface ReviewPageData {
  session: PrReviewSessionDto | null;
  task: TaskPrReviewPageDto["task"] | null;
  run: PrReviewRunDto | null;
}

interface ReviewPageShellProps {
  data: ReviewPageData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
  onChanged: () => void;
}

function ReviewPageShell({ data, loading, error, onRetry, onBack, onChanged }: ReviewPageShellProps) {
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageState data={data} loading={loading} error={error} onRetry={onRetry} loadingLabel="loading review...">
        {(dto) => (
          dto.run
            ? <ReviewRun dto={dto} onBack={onBack} onChanged={onChanged} />
            : <UnavailableReview onBack={onBack} />
        )}
      </PageState>
    </div>
  );
}

interface ReviewRunProps {
  dto: ReviewPageData & { run: PrReviewRunDto };
  onBack: () => void;
  onChanged: () => void;
}

function ReviewRun({ dto, onBack, onChanged }: ReviewRunProps) {
  const { run, session, task } = dto;
  const { setHidden } = useNavState();
  const centerScrollRef = useHideNavOnContainerScroll(setHidden);

  const allFiles = useMemo(
    () => run.chapters.flatMap((chapter) => chapter.files.map((file) => file.path)),
    [run.chapters],
  );
  const [activeFile, setActiveFile] = useState<string | null>(allFiles[0] ?? null);
  const [attachedAnnotation, setAttachedAnnotation] = useState<PrReviewAnnotation | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { viewed, toggleViewed } = useViewedFiles(run.headSha);

  const toggleCollapse = useCallback((file: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  const handleReplyAnnotation = useCallback((annotation: PrReviewAnnotation) => {
    setAttachedAnnotation(annotation);
    setActiveFile(annotation.filePath);
  }, []);

  useEffect(() => {
    setActiveFile(allFiles[0] ?? null);
  }, [allFiles, run.headSha]);

  const annotationsByFile = useMemo(() => {
    const map = new Map<string, PrReviewAnnotation[]>();
    for (const chapter of run.chapters) {
      for (const annotation of chapter.annotations) {
        const list = map.get(annotation.filePath) ?? [];
        map.set(annotation.filePath, [...list, annotation]);
      }
    }
    return map;
  }, [run.chapters]);

  const patchByFile = useMemo(
    () => new Map(splitUnifiedDiffByFile(run.diffPatch).map((patch) => [patch.filePath, patch.patch])),
    [run.diffPatch],
  );

  const fileRefs = useRef<Map<string, HTMLElement>>(new Map());

  const focusFile = useCallback((file: string) => {
    setActiveFile(file);
    const el = fileRefs.current.get(file);
    if (el) {
      requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }, []);

  useScrollSpyActiveFile(allFiles, fileRefs, setActiveFile);

  return (
    <div className="-mx-2 flex flex-1 min-h-0 flex-col animate-fade-in">
      <ResizablePanels
        storageKey="pr-review-panels"
        className="h-full"
        leftLabel="Files"
        rightLabel="Review thread"
        left={
          <FileTree
            chapters={run.chapters}
            activeFile={activeFile}
            onSelectFile={focusFile}
          />
        }
        center={
          <div className="flex min-h-0 min-w-0 h-full flex-col overflow-hidden">
            {/* Center header — aligned with side panel headers */}
            <header className="flex shrink-0 items-center border-b border-glass-border px-5 py-3">
              <button
                type="button"
                onClick={onBack}
                className="group flex items-center gap-1.5 font-mono text-[10px] text-text-ghost transition-colors hover:text-text-dim"
              >
                <ArrowLeft size={10} className="transition-transform group-hover:-translate-x-0.5" />
                back
              </button>
            </header>
            <div ref={centerScrollRef} className="min-h-0 flex-1 overflow-y-auto px-[18px] pt-4 pb-[18px]">
            <ReviewHeader
              title={run.prTitle}
              repo={session?.repo ?? task?.repo ?? "PR"}
              prNumber={session?.prNumber ?? task?.prNumber ?? null}
              sha={run.headSha}
              createdAt={run.createdAt}
            />
            <FileStack
              summary={run.summary}
              visualSnapshot={run.visualSnapshot}
              chapters={run.chapters}
              patchByFile={patchByFile}
              annotationsByFile={annotationsByFile}
              activeFile={activeFile}
              viewed={viewed}
              collapsed={collapsed}
              diffStyle="unified"
              fileRefs={fileRefs}
              onReplyAnnotation={handleReplyAnnotation}
              onSelectFile={setActiveFile}
              onToggleCollapse={toggleCollapse}
              onToggleViewed={toggleViewed}
            />
          </div>
          </div>
        }
        right={
          session ? (
            <ReviewChat
              sessionId={session.id}
              mode={session.mode}
              activeFile={activeFile}
              attachedAnnotation={attachedAnnotation}
              onClearAnnotation={() => setAttachedAnnotation(null)}
              onChanged={onChanged}
            />
          ) : (
            <ReviewChatUnavailable reason="Review chat is unavailable because this review has no linked PR session." />
          )
        }
      />
    </div>
  );
}

// --- Header ---

interface ReviewHeaderProps {
  title: string;
  repo: string;
  prNumber: number | null;
  sha: string;
  createdAt: string;
}

function ReviewHeader({ title, repo, prNumber, sha, createdAt }: ReviewHeaderProps) {
  return (
    <header className="px-2 pb-0">
      {/* Full-width header card */}
      <div className="rounded-lg border border-glass-border bg-glass px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          {/* Left: title + repo pill */}
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex items-center gap-2.5">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-ghost px-2.5 py-0.5 font-mono text-[10px] font-medium text-accent">
                <GitPullRequest size={10} />
                {repo}
                {prNumber !== null && <span className="text-text-dim">#{prNumber}</span>}
              </span>
              <span className="rounded-full border border-glass-border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-text-ghost">
                review
              </span>
            </div>
            <h1 className="font-display text-[20px] font-medium leading-tight tracking-[-0.02em] text-text">
              {title}
            </h1>
          </div>

          {/* Right: date + sha */}
          <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
            <span className="font-mono text-[11px] text-text-void">
              {formatDate(createdAt)}
            </span>
            <span className="font-mono text-[11px] text-text-ghost">
              {sha.slice(0, 7)}
            </span>
          </div>
        </div>
      </div>

      {/* Separator */}
      <div className="mt-4 border-t border-glass-border" />
    </header>
  );
}

// --- Empty States ---

interface UnavailableReviewProps {
  onBack: () => void;
}

function UnavailableReview({ onBack }: UnavailableReviewProps) {
  return (
    <div className="px-2 py-8">
      <button
        type="button"
        onClick={onBack}
        className="group mb-5 flex items-center gap-1 font-mono text-[10px] text-text-ghost transition-colors hover:text-text-dim"
      >
        <ArrowLeft size={10} className="transition-transform group-hover:-translate-x-0.5" />
        back
      </button>
      <h1 className="font-display text-[18px] text-text">Review unavailable</h1>
      <p className="mt-3 font-body text-[12px] leading-relaxed text-text-secondary">
        The dashboard model for this PR review has not been generated yet, or it failed validation.
        Check the GitHub PR comment for the analyst summary.
      </p>
    </div>
  );
}

function ReviewChatUnavailable({ reason }: { reason: string }) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-1 items-center justify-center px-4 text-center">
        <p className="font-mono text-[11px] text-text-secondary">{reason}</p>
      </div>
    </div>
  );
}

// --- Scroll Spy ---

/** Sync `activeFile` with whatever file card is currently in the top band of the viewport. */
function useScrollSpyActiveFile(
  files: string[],
  fileRefs: React.MutableRefObject<Map<string, HTMLElement>>,
  setActiveFile: (file: string | null) => void,
): void {
  useEffect(() => {
    if (!files.length) return;
    const elementToFile = new Map<Element, string>();
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length === 0) return;
        const file = elementToFile.get(visible[0].target);
        if (file) setActiveFile(file);
      },
      { rootMargin: "-80px 0px -65% 0px", threshold: 0 },
    );
    for (const [file, el] of fileRefs.current.entries()) {
      elementToFile.set(el, file);
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [files, fileRefs, setActiveFile]);
}
