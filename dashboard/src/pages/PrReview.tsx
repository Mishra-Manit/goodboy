/** PR review page: V8 stacked-diff layout. Left file rail · center file stack · right review thread. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { fetchPrReviewPage } from "@dashboard/lib/api/pr-sessions";
import { splitUnifiedDiffByFile } from "@dashboard/lib/diff-patch";
import { formatDate } from "@dashboard/lib/format";
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
    () => new Set(allFiles),
  );

  useEffect(() => {
    setActiveFile(allFiles[0] ?? null);
    setExpandedFiles(new Set(allFiles));
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
  const severity =
    concernCount > 0
      ? `${concernCount} concern${concernCount === 1 ? "" : "s"}`
      : totalAnnotations > 0
        ? `${totalAnnotations} note${totalAnnotations === 1 ? "" : "s"}`
        : "no concerns";

  return (
    <div className="-mx-2 mt-2 flex flex-col">
      <ReviewHeader
        title={run.prTitle}
        repo={session.repo}
        prNumber={session.prNumber}
        sha={run.headSha}
        createdAt={run.createdAt}
      />

      <div className="mt-4 grid min-h-[calc(100vh-12rem)] grid-cols-1 gap-0 lg:grid-cols-[244px_minmax(0,1fr)_400px]">
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

        <div className="min-w-0 px-[18px] py-[18px]">
          <FileStack
            chapters={run.chapters}
            orderedChapterIds={run.orderedChapterIds}
            patchByFile={patchByFile}
            annotationsByFile={annotationsByFile}
            activeFile={activeFile}
            expandedFiles={expandedFiles}
            onToggleExpand={toggleExpand}
            onSelectFile={setActiveFile}
            diffStyle="unified"
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
        severity={severity}
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
    <div className="flex items-center gap-4 px-6 pb-4">
      <div className="flex shrink-0 items-baseline gap-2">
        <span className="font-mono text-[11px] font-medium text-accent">{repo}</span>
        {prNumber !== null && (
          <span className="font-mono text-[11px] text-text-dim">#{prNumber}</span>
        )}
      </div>

      <h1 className="min-w-0 flex-1 truncate font-display text-[18px] font-normal leading-tight tracking-tight text-text">
        {title}
      </h1>

      <div className="hidden shrink-0 items-center gap-x-5 font-mono text-[10px] text-text-void md:flex">
        <span>{formatDate(createdAt)}</span>
        <span>sha {sha.slice(0, 7)}</span>
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
    currentIndex >= 0 ? `file ${currentIndex + 1} of ${total}` : `${total} files`;
  return (
    <div className="sticky bottom-0 z-10 mt-[18px] flex h-8 items-center justify-between border-t border-glass-border bg-bg/95 px-2 backdrop-blur">
      <span className="font-mono text-[10px] text-text-dim">
        {noteLabel}
        <span className="text-text-void">  ·  {severity}</span>
      </span>
      <span className="font-mono text-[10px] text-text-void">
        j/k step  ·  e expand  ·  r reply  ·  ⌘⏎ merge
      </span>
    </div>
  );
}

// --- Empty state ---

function UnavailableReview() {
  return (
    <div className="px-2 py-8">
      <h1 className="font-display text-[18px] text-text">Review unavailable</h1>
      <p className="mt-3 font-body text-[12px] leading-relaxed text-text-secondary">
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
