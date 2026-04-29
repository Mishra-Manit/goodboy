/** PR review page: file-tree left, focused split diff right, inline pierre comments. */

import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { fetchPrReviewPage } from "@dashboard/lib/api/pr-sessions";
import { splitUnifiedDiffByFile } from "@dashboard/lib/diff-patch";
import { formatDate } from "@dashboard/lib/format";
import type { PrReviewAnnotation, PrReviewPageDto } from "@dashboard/shared";
import { useQuery } from "@dashboard/hooks/use-query";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { FileTree } from "@dashboard/components/pr-review/FileTree";
import { FileDiff } from "@dashboard/components/pr-review/FileDiff";
import { cn } from "@dashboard/lib/utils";

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
        {(dto) => (dto.run ? <ReviewRun run={dto.run} /> : <UnavailableReview />)}
      </PageState>
    </div>
  );
}

// --- Run ---

interface ReviewRunProps {
  run: NonNullable<PrReviewPageDto["run"]>;
}

function ReviewRun({ run }: ReviewRunProps) {
  const [diffStyle, setDiffStyle] = useState<"split" | "unified">("split");
  const allFiles = useMemo(
    () => run.orderedChapterIds.flatMap((id) => run.chapters.find((c) => c.id === id)?.files ?? []),
    [run.chapters, run.orderedChapterIds],
  );
  const [activeFile, setActiveFile] = useState<string | null>(allFiles[0] ?? null);

  // Reset focus when the run changes (different headSha).
  useEffect(() => {
    setActiveFile(allFiles[0] ?? null);
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

  useFileKeyboardNavigation(allFiles, activeFile, setActiveFile);

  return (
    <div className="mt-2">
      <MetaStrip
        title={run.prTitle}
        sha={run.headSha}
        createdAt={run.createdAt}
        summary={run.summary}
        diffStyle={diffStyle}
        onDiffStyle={setDiffStyle}
      />
      <div className="mt-6 grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto lg:pr-2">
          <FileTree
            chapters={run.chapters}
            orderedChapterIds={run.orderedChapterIds}
            activeFile={activeFile}
            onSelectFile={setActiveFile}
          />
        </aside>
        <div className="min-w-0">
          {activeFile ? (
            <FileDiff
              filePath={activeFile}
              patch={patchByFile.get(activeFile) ?? null}
              annotations={annotationsByFile.get(activeFile) ?? []}
              diffStyle={diffStyle}
            />
          ) : (
            <div className="rounded-md border border-glass-border bg-glass p-6 text-center font-mono text-[12px] italic text-text-dim">
              select a file to review
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Bits ---

interface MetaStripProps {
  title: string;
  sha: string;
  createdAt: string;
  summary: string;
  diffStyle: "split" | "unified";
  onDiffStyle: (s: "split" | "unified") => void;
}

function MetaStrip({ title, sha, createdAt, summary, diffStyle, onDiffStyle }: MetaStripProps) {
  return (
    <div className="border-b border-glass-border pb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="min-w-0 truncate font-display text-[18px] font-semibold tracking-tight text-text">
          {title}
        </h1>
        <DiffStyleToggle value={diffStyle} onChange={onDiffStyle} />
      </div>
      <div className="mt-1 font-mono text-[11px] text-text-void">
        reviewed at {sha.slice(0, 7)} · {formatDate(createdAt)}
      </div>
      <p className="mt-3 max-w-[820px] font-body text-[13px] leading-relaxed text-text-secondary">
        {summary}
      </p>
    </div>
  );
}

function DiffStyleToggle({
  value,
  onChange,
}: {
  value: "split" | "unified";
  onChange: (s: "split" | "unified") => void;
}) {
  const options: { id: "split" | "unified"; label: string }[] = [
    { id: "split", label: "split" },
    { id: "unified", label: "unified" },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-glass-border bg-glass p-0.5">
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className={cn(
              "rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
              active ? "bg-white/[0.07] text-text" : "text-text-dim hover:text-text-secondary",
            )}
          >
            {opt.label}
          </button>
        );
      })}
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

// --- Keyboard nav ---

function useFileKeyboardNavigation(
  files: string[],
  activeFile: string | null,
  setActiveFile: (file: string) => void,
): void {
  useEffect(() => {
    if (!files.length) return;
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const currentIndex = activeFile ? Math.max(0, files.indexOf(activeFile)) : 0;
      if (event.key === "j" || event.key === "ArrowDown") {
        const next = files[Math.min(currentIndex + 1, files.length - 1)];
        if (next) setActiveFile(next);
      } else if (event.key === "k" || event.key === "ArrowUp") {
        const previous = files[Math.max(currentIndex - 1, 0)];
        if (previous) setActiveFile(previous);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeFile, files, setActiveFile]);
}
