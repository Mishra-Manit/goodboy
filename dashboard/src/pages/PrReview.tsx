/** PR review page: V8 stacked-diff layout. Left file rail · center file stack · right review thread. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import { fetchPrReviewPage } from "@dashboard/lib/api/pr-sessions";
import { splitUnifiedDiffByFile } from "@dashboard/lib/diff-patch";
import type { PrReviewAnnotation, PrReviewPageDto } from "@dashboard/shared";
import { useQuery } from "@dashboard/hooks/use-query";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { FileTree } from "@dashboard/components/pr-review/FileTree";
import { FileStack } from "@dashboard/components/pr-review/FileStack";
import { ReviewChat } from "@dashboard/components/pr-review/ReviewChat";

export function PrReview() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/prs" replace />;
  return <PrReviewContent sessionId={id} />;
}

interface PrReviewContentProps {
  sessionId: string;
}

function PrReviewContent({ sessionId }: PrReviewContentProps) {
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useQuery(
    () => fetchPrReviewPage(sessionId),
    [sessionId],
  );
  return (
    <div className="animate-fade-in">
      <BackLink label="back to session" onClick={() => navigate(`/prs/${sessionId}`)} />
      <PageState data={data} loading={loading} error={error} onRetry={refetch} loadingLabel="loading review...">
        {(dto) => (dto.run ? <ReviewRun dto={dto} /> : <UnavailableReview />)}
      </PageState>
    </div>
  );
}

interface ReviewRunProps {
  dto: PrReviewPageDto;
}

function ReviewRun({ dto }: ReviewRunProps) {
  const run = dto.run!;
  const session = dto.session;
  const allFiles = useMemo(
    () => run.orderedChapterIds.flatMap((id) => run.chapters.find((c) => c.id === id)?.files ?? []),
    [run.chapters, run.orderedChapterIds],
  );
  const [activeFile, setActiveFile] = useState<string | null>(allFiles[0] ?? null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(allFiles.slice(0, 1)),
  );

  useEffect(() => {
    setActiveFile(allFiles[0] ?? null);
    setExpandedFiles(new Set(allFiles.slice(0, 1)));
  }, [run.headSha]);

  const annotationsByFile = useMemo(() => {
    const map = new Map<string, PrReviewAnnotation[]>();
    for (const chapter of run.chapters) {
      for (const annotation of chapter.annotations) {
        const list = map.get(annotation.filePath) ?? [];
        list.push(annotation);
        map.set(annotation.filePath, list);
      }
    }
    return map;
  }, [run.chapters]);

  const patchByFile = useMemo(
    () => new Map(splitUnifiedDiffByFile(run.diffPatch).map((p) => [p.filePath, p.patch])),
    [run.diffPatch],
  );

  const totalAnnotations = useMemo(
    () => run.chapters.reduce((acc, c) => acc + c.annotations.length, 0),
    [run.chapters],
  );
  const concernCount = useMemo(
    () =>
      run.chapters.reduce(
        (acc, c) => acc + c.annotations.filter((a) => a.kind === "concern").length,
        0,
      ),
    [run.chapters],
  );

  const fileRefs = useRef<Map<string, HTMLElement>>(new Map());

  const focusFile = useCallback(
    (file: string) => {
      setActiveFile(file);
      setExpandedFiles((prev) => {
        if (prev.has(file)) return prev;
        const next = new Set(prev);
        next.add(file);
        return next;
      });
      const el = fileRefs.current.get(file);
      if (el) {
        requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
    },
    [],
  );

  const toggleExpand = useCallback((file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);

  useFileKeyboardNavigation(allFiles, activeFile, focusFile);

  const activeIndex = activeFile ? allFiles.indexOf(activeFile) : -1;
  const concernSeverity =
    concernCount > 0 ? "high concern" : totalAnnotations > 0 ? "low concern" : "no concerns";

  return (
    <div className="-mx-2 mt-2 flex flex-col">
      <ReviewHeader
        title={run.prTitle}
        threadCount={totalAnnotations}
      />

      <div className="mt-5 grid min-h-[calc(100vh-12rem)] grid-cols-1 gap-0 lg:grid-cols-[260px_minmax(0,1fr)_420px]">
        <aside className="border-glass-border lg:border-r">
          <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
            <FileTree
              chapters={run.chapters}
              orderedChapterIds={run.orderedChapterIds}
              activeFile={activeFile}
              onSelectFile={focusFile}
            />
          </div>
        </aside>

        <div className="min-w-0 px-[22px] py-[18px]">
          <FileStack
            chapters={run.chapters}
            orderedChapterIds={run.orderedChapterIds}
            patchByFile={patchByFile}
            annotationsByFile={annotationsByFile}
            activeFile={activeFile}
            expandedFiles={expandedFiles}
            onToggleExpand={toggleExpand}
            onSelectFile={setActiveFile}
            diffStyle="split"
            fileRefs={fileRefs}
          />
        </div>

        <aside className="border-glass-border lg:border-l">
          <div className="lg:sticky lg:top-20 lg:h-[calc(100vh-7rem)]">
            <ReviewChat prNumber={session.prNumber} branch={session.branch} />
          </div>
        </aside>
      </div>

      <BottomBar
        currentIndex={activeIndex}
        total={allFiles.length}
        severity={concernSeverity}
      />
    </div>
  );
}

// --- Header ---

interface ReviewHeaderProps {
  title: string;
  threadCount: number;
}

function ReviewHeader({ title, threadCount }: ReviewHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-2 pb-4">
      <div className="flex min-w-0 items-center gap-[18px]">
        <span className="rounded-[4px] border border-accent-dim bg-accent-ghost px-[10px] py-[6px] font-mono text-[10px] font-semibold tracking-[0.3em] text-accent">
          V8  CHAT REVIEW
        </span>
        <h1 className="min-w-0 truncate font-display text-[22px] font-normal tracking-tight text-text">
          {title}
        </h1>
        <span className="hidden items-center gap-2 rounded-full border border-glass-border bg-glass py-[5px] pl-[10px] pr-[14px] sm:flex">
          <span className="h-[7px] w-[7px] rounded-full bg-ok" />
          <span className="font-mono text-[10px] font-medium tracking-[0.1em] text-text-dim">
            Claude reviewing · live
          </span>
        </span>
      </div>

      <div className="flex items-center gap-[10px]">
        <span className="flex items-center gap-[7px] rounded-md border border-glass-border bg-glass px-[11px] py-[7px]">
          <MessageSquare className="h-3 w-3 text-text-dim" strokeWidth={1.5} />
          <span className="font-mono text-[10px] font-semibold tracking-[0.18em] text-text-dim">
            {threadCount} {threadCount === 1 ? "THREAD" : "THREADS"}
          </span>
        </span>
        <button
          type="button"
          className="flex items-center gap-[6px] rounded-lg bg-accent px-4 py-[9px] font-body text-[12px] font-bold text-bg transition-opacity hover:opacity-90"
        >
          Approve &amp; merge ⌘⏎
        </button>
      </div>
    </div>
  );
}

// --- Bottom bar ---

interface BottomBarProps {
  currentIndex: number;
  total: number;
  severity: string;
}

function BottomBar({ currentIndex, total, severity }: BottomBarProps) {
  const noteLabel =
    currentIndex >= 0 ? `Note ${currentIndex + 1} of ${total}` : `${total} files`;
  return (
    <div className="sticky bottom-0 mt-[18px] flex h-8 items-center justify-between border-t border-glass-border bg-bg px-2">
      <span className="font-mono text-[11px] text-text-dim">
        {noteLabel}
        <span className="text-text-void">{"  ·  "}{severity}</span>
      </span>
      <span className="font-mono text-[10px] text-text-ghost">
        j / k step  ·  e expand  ·  r reply  ·  ⌘⏎ merge
      </span>
    </div>
  );
}

// --- Empty state ---

function UnavailableReview() {
  return (
    <div className="px-2 py-8">
      <h1 className="font-display text-[20px] text-text">Review unavailable</h1>
      <p className="mt-3 font-body text-[13px] leading-relaxed text-text-secondary">
        The dashboard model for this PR review has not been generated yet, or it failed validation.
        Check the GitHub PR comment for the analyst summary.
      </p>
    </div>
  );
}

// --- Keyboard nav ---

function useFileKeyboardNavigation(
  files: string[],
  activeFile: string | null,
  focusFile: (file: string) => void,
): void {
  useEffect(() => {
    if (!files.length) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const currentIndex = activeFile ? Math.max(0, files.indexOf(activeFile)) : 0;
      if (event.key === "j" || event.key === "ArrowDown") {
        const next = files[Math.min(currentIndex + 1, files.length - 1)];
        if (next) focusFile(next);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        const previous = files[Math.max(currentIndex - 1, 0)];
        if (previous) focusFile(previous);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeFile, files, focusFile]);
}
