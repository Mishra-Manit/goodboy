/** PR review page: natural-language diff layout. Left file rail · center narrative stack · right review thread. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, GitPullRequest } from "lucide-react";
import { fetchPrReviewPage } from "@dashboard/lib/api/pr-sessions";
import { splitUnifiedDiffByFile } from "@dashboard/lib/diff-patch";
import { formatDate } from "@dashboard/lib/format";
import type { PrReviewAnnotation, PrReviewPageDto } from "@dashboard/shared";
import { useQuery } from "@dashboard/hooks/use-query";
import { PageState } from "@dashboard/components/PageState";
import { FileStack } from "@dashboard/components/pr-review/FileStack";
import { FileTree } from "@dashboard/components/pr-review/FileTree";
import { ResizablePanels } from "@dashboard/components/pr-review/ResizablePanels";
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
    `pr-review:${sessionId}`,
    () => fetchPrReviewPage(sessionId),
  );
  return (
    <div className="animate-fade-in">
      <PageState data={data} loading={loading} error={error} onRetry={refetch} loadingLabel="loading review...">
        {(dto) => (
          dto.run
            ? <ReviewRun dto={dto} onBack={() => navigate(`/prs/${sessionId}`)} onChanged={refetch} />
            : <UnavailableReview />
        )}
      </PageState>
    </div>
  );
}

interface ReviewRunProps {
  dto: PrReviewPageDto;
  onBack: () => void;
  onChanged: () => void;
}

function ReviewRun({ dto, onBack, onChanged }: ReviewRunProps) {
  const run = dto.run!;
  const session = dto.session;
  const allFiles = useMemo(
    () => run.chapters.flatMap((chapter) => chapter.files.map((file) => file.path)),
    [run.chapters],
  );
  const [activeFile, setActiveFile] = useState<string | null>(allFiles[0] ?? null);
  const [attachedAnnotation, setAttachedAnnotation] = useState<PrReviewAnnotation | null>(null);

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
    <div className="-mx-2 mt-2 flex flex-col">
      <ReviewHeader
        title={run.prTitle}
        repo={session.repo}
        prNumber={session.prNumber}
        sha={run.headSha}
        createdAt={run.createdAt}
        onBack={onBack}
      />

      <ResizablePanels
        storageKey="pr-review-panels"
        className="min-h-[calc(100vh-12rem)]"
        left={
          <aside className="min-w-0">
            <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
              <FileTree
                chapters={run.chapters}
                activeFile={activeFile}
                onSelectFile={focusFile}
              />
            </div>
          </aside>
        }
        center={
          <div className="min-w-0 px-[18px] py-[18px]">
            <FileStack
              summary={run.summary}
              chapters={run.chapters}
              patchByFile={patchByFile}
              annotationsByFile={annotationsByFile}
              activeFile={activeFile}
              diffStyle="unified"
              fileRefs={fileRefs}
              onReplyAnnotation={handleReplyAnnotation}
              onSelectFile={setActiveFile}
            />
          </div>
        }
        right={
          <aside className="min-w-0">
            <div className="lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)]">
              <ReviewChat
                sessionId={session.id}
                mode={session.mode}
                activeFile={activeFile}
                attachedAnnotation={attachedAnnotation}
                onClearAnnotation={() => setAttachedAnnotation(null)}
                onChanged={onChanged}
              />
            </div>
          </aside>
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
  onBack: () => void;
}

function ReviewHeader({ title, repo, prNumber, sha, createdAt, onBack }: ReviewHeaderProps) {
  return (
    <header className="px-2 pb-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-text-void">
        <button
          type="button"
          onClick={onBack}
          className="group flex items-center gap-1 text-text-ghost transition-colors hover:text-text-dim"
        >
          <ArrowLeft size={10} className="transition-transform group-hover:-translate-x-0.5" />
          back
        </button>
        <span className="text-text-ghost/40">·</span>
        <GitPullRequest size={11} className="text-text-ghost" />
        <span className="text-[11px] font-medium text-accent">{repo}</span>
        {prNumber !== null && (
          <span className="text-[11px] text-text-dim">#{prNumber}</span>
        )}
        <span className="text-text-ghost/40">·</span>
        <span className="uppercase tracking-[0.14em] text-text-ghost/60">review</span>
        <span className="text-text-ghost/40">·</span>
        <span>{formatDate(createdAt)}</span>
        <span className="text-text-ghost/40">·</span>
        <span>sha {sha.slice(0, 7)}</span>
      </div>

      <h1 className="font-display text-[20px] font-normal leading-tight tracking-tight text-text">
        {title}
      </h1>
    </header>
  );
}

// --- Empty State ---

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
