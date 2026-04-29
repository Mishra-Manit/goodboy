import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { fetchPrReviewPage } from "@dashboard/lib/api/pr-sessions";
import { splitUnifiedDiffByFile } from "@dashboard/lib/diff-patch";
import { formatDate } from "@dashboard/lib/format";
import type { PrReviewPageDto } from "@dashboard/shared";
import { useQuery } from "@dashboard/hooks/use-query";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { ChapterTabs } from "@dashboard/components/pr-review/ChapterTabs";
import { ChapterHeader } from "@dashboard/components/pr-review/ChapterHeader";
import { FilePatchView } from "@dashboard/components/pr-review/FilePatchView";

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
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const { data, loading, error, refetch } = useQuery(
    () => fetchPrReviewPage(sessionId),
    [sessionId],
  );

  useEffect(() => {
    setActiveChapterId(data?.run?.orderedChapterIds[0] ?? null);
  }, [data?.run?.headSha]);

  useChapterKeyboardNavigation(data, activeChapterId, setActiveChapterId);

  return (
    <div className="animate-fade-in">
      <BackLink label="back to session" onClick={() => navigate(`/prs/${sessionId}`)} />
      <PageState data={data} loading={loading} error={error} onRetry={refetch} loadingLabel="loading review...">
        {(dto) => (
          dto.run
            ? <ReviewRun run={dto.run} activeChapterId={activeChapterId} onSelectChapter={setActiveChapterId} />
            : <UnavailableReview />
        )}
      </PageState>
    </div>
  );
}

interface ReviewRunProps {
  run: NonNullable<PrReviewPageDto["run"]>;
  activeChapterId: string | null;
  onSelectChapter: (id: string) => void;
}

function ReviewRun({ run, activeChapterId, onSelectChapter }: ReviewRunProps) {
  const activeChapter = run.chapters.find((chapter) => chapter.id === activeChapterId) ?? run.chapters[0];
  const patchByFile = useMemo(
    () => new Map(splitUnifiedDiffByFile(run.diffPatch).map((patch) => [patch.filePath, patch.patch])),
    [run.diffPatch],
  );
  if (!activeChapter) return null;
  const activeIndex = Math.max(0, run.orderedChapterIds.indexOf(activeChapter.id));

  return (
    <div className="px-2 py-4">
      <h1 className="mt-2 font-display text-[20px] font-semibold tracking-tight text-text">
        {run.prTitle}
      </h1>
      <div className="mt-1 font-mono text-[11px] text-text-dim">
        reviewed at {run.headSha.slice(0, 7)} · {formatDate(run.createdAt)}
      </div>

      <p className="mt-6 max-w-[660px] font-body text-[13px] leading-relaxed text-text-secondary">
        {run.summary}
      </p>

      <div className="mt-10">
        <ChapterTabs
          chapters={run.chapters}
          orderedIds={run.orderedChapterIds}
          activeId={activeChapter.id}
          onSelect={onSelectChapter}
        />
      </div>

      <ChapterHeader chapter={activeChapter} index={activeIndex} />

      <div
        id={`panel-${activeChapter.id}`}
        role="tabpanel"
        aria-labelledby={`tab-${activeChapter.id}`}
        tabIndex={0}
        className="mt-6 space-y-8 outline-none"
      >
        {activeChapter.files.map((file) => {
          const patch = patchByFile.get(file) ?? null;
          const fileAnnotations = activeChapter.annotations.filter((annotation) => annotation.filePath === file);
          return (
            <div key={file}>
              <div className="mb-2 font-mono text-[11px] text-text-dim">{file}</div>
              {patch ? (
                <FilePatchView patch={patch} annotations={fileAnnotations} />
              ) : (
                <div className="rounded-md border border-glass-border bg-glass p-4 font-mono text-[11px] italic text-text-dim">
                  diff unavailable for this file
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

function useChapterKeyboardNavigation(
  data: PrReviewPageDto | null,
  activeChapterId: string | null,
  setActiveChapterId: (id: string) => void,
): void {
  const ordered = data?.run?.orderedChapterIds ?? [];

  useEffect(() => {
    if (!ordered.length) return;

    function onKey(event: KeyboardEvent) {
      const currentIndex = activeChapterId ? ordered.indexOf(activeChapterId) : 0;
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      if (event.key === "j" || event.key === "ArrowRight") {
        const next = ordered[Math.min(safeIndex + 1, ordered.length - 1)];
        if (next) setActiveChapterId(next);
      } else if (event.key === "k" || event.key === "ArrowLeft") {
        const previous = ordered[Math.max(safeIndex - 1, 0)];
        if (previous) setActiveChapterId(previous);
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeChapterId, ordered]);
}
