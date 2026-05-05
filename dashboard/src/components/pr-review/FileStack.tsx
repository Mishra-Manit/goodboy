/** Center scroll: overall summary, then for each chapter: group narrative header + 2-panel file cards. */

import { FileCode, FileText } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation, PrReviewChapter } from "@dashboard/shared";
import { FileDiff } from "./FileDiff";
import { NlFilePanel } from "./NlFilePanel";

interface FileStackProps {
  summary: string;
  chapters: PrReviewChapter[];
  patchByFile: Map<string, string>;
  annotationsByFile: Map<string, PrReviewAnnotation[]>;
  activeFile: string | null;
  diffStyle: "split" | "unified";
  fileRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
  onSelectFile: (file: string) => void;
}

export function FileStack({
  summary,
  chapters,
  patchByFile,
  annotationsByFile,
  activeFile,
  diffStyle,
  fileRefs,
  onReplyAnnotation,
  onSelectFile,
}: FileStackProps) {
  return (
    <div className="flex flex-col gap-6">
      <OverallSummary summary={summary} />
      {chapters.map((chapter) => (
        <ChapterSection
          key={chapter.id}
          chapter={chapter}
          patchByFile={patchByFile}
          annotationsByFile={annotationsByFile}
          activeFile={activeFile}
          diffStyle={diffStyle}
          fileRefs={fileRefs}
          onReplyAnnotation={onReplyAnnotation}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}

// --- Overall Summary ---

function OverallSummary({ summary }: { summary: string }) {
  return (
    <section className="rounded-xl border border-accent-dim bg-bg px-5 py-4">
      <h2 className="mb-2 font-display text-[15px] font-medium text-text">
        Overall PR diff
      </h2>
      <p className="font-body text-[12px] leading-[1.7] text-text-dim">{summary}</p>
    </section>
  );
}

// --- Chapter Section ---

interface ChapterSectionProps {
  chapter: PrReviewChapter;
  patchByFile: Map<string, string>;
  annotationsByFile: Map<string, PrReviewAnnotation[]>;
  activeFile: string | null;
  diffStyle: "split" | "unified";
  fileRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
  onSelectFile: (file: string) => void;
}

function ChapterSection({
  chapter,
  patchByFile,
  annotationsByFile,
  activeFile,
  diffStyle,
  fileRefs,
  onReplyAnnotation,
  onSelectFile,
}: ChapterSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <GroupNarrativeHeader title={chapter.title} narrative={chapter.narrative} />
      {chapter.files.map((file) => (
        <FileCard
          key={file.path}
          filePath={file.path}
          fileNarrative={file.narrative}
          patch={patchByFile.get(file.path) ?? null}
          annotations={annotationsByFile.get(file.path) ?? []}
          active={file.path === activeFile}
          diffStyle={diffStyle}
          onReplyAnnotation={onReplyAnnotation}
          registerRef={(el) => {
            if (el) fileRefs.current.set(file.path, el);
            else fileRefs.current.delete(file.path);
          }}
          onFocus={() => onSelectFile(file.path)}
        />
      ))}
    </div>
  );
}

// --- Group Narrative Header ---

function GroupNarrativeHeader({ title, narrative }: { title: string; narrative: string }) {
  return (
    <div className="flex flex-col gap-1 px-1">
      <h3 className="font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-text-secondary">
        {title}
      </h3>
      <p className="font-body text-[12px] leading-[1.65] text-text-dim">{narrative}</p>
    </div>
  );
}

// --- File Card ---

interface FileCardProps {
  filePath: string;
  fileNarrative: string;
  patch: string | null;
  annotations: PrReviewAnnotation[];
  active: boolean;
  diffStyle: "split" | "unified";
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
  registerRef: (el: HTMLElement | null) => void;
  onFocus: () => void;
}

function FileCard({
  filePath,
  fileNarrative,
  patch,
  annotations,
  active,
  diffStyle,
  onReplyAnnotation,
  registerRef,
  onFocus,
}: FileCardProps) {
  const stats = patch ? countStats(patch) : null;
  const Icon = isCode(filePath) ? FileCode : FileText;

  return (
    <section
      ref={registerRef}
      onClick={onFocus}
      className={cn(
        "scroll-mt-24 overflow-hidden rounded-xl border bg-bg transition-colors",
        active ? "border-accent-dim" : "border-glass-border",
      )}
    >
      <div className="flex h-10 items-center gap-[10px] bg-bg-active px-4">
        <Icon className="h-3.5 w-3.5 shrink-0 text-text-ghost" strokeWidth={1.5} />
        <span className="min-w-0 truncate font-mono text-[12px] text-text">{filePath}</span>
        {stats && (
          <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-text-ghost">
            +{stats.adds} −{stats.dels}
          </span>
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] divide-x divide-glass-border border-t border-glass-border bg-bg-raised">
        <NlFilePanel
          narrative={fileNarrative}
          annotations={annotations}
          onReplyAnnotation={onReplyAnnotation}
        />
        <FileDiff filePath={filePath} patch={patch} diffStyle={diffStyle} />
      </div>
    </section>
  );
}

// --- Helpers ---

function countStats(patch: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds += 1;
    else if (line.startsWith("-")) dels += 1;
  }
  return { adds, dels };
}

function isCode(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java|rb|swift|kt|c|cpp|h)$/.test(filePath);
}
