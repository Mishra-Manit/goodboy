/** Center stack: each file is a collapsible card; expanded cards render full diff. */

import { useMemo } from "react";
import { ChevronDown, ChevronUp, FileCode, FileText } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation, PrReviewChapter } from "@dashboard/shared";
import { FileDiff } from "./FileDiff";

interface FileStackProps {
  chapters: PrReviewChapter[];
  orderedChapterIds: string[];
  patchByFile: Map<string, string>;
  annotationsByFile: Map<string, PrReviewAnnotation[]>;
  activeFile: string | null;
  expandedFiles: Set<string>;
  onToggleExpand: (file: string) => void;
  onSelectFile: (file: string) => void;
  diffStyle: "split" | "unified";
  fileRefs: React.MutableRefObject<Map<string, HTMLElement>>;
}

export function FileStack({
  chapters,
  orderedChapterIds,
  patchByFile,
  annotationsByFile,
  activeFile,
  expandedFiles,
  onToggleExpand,
  onSelectFile,
  diffStyle,
  fileRefs,
}: FileStackProps) {
  const fileToChapter = useMemo(() => {
    const map = new Map<string, PrReviewChapter>();
    for (const chapter of chapters) {
      for (const file of chapter.files) map.set(file, chapter);
    }
    return map;
  }, [chapters]);

  const orderedFiles = useMemo(() => {
    const byId = new Map(chapters.map((c) => [c.id, c]));
    return orderedChapterIds.flatMap((id) => byId.get(id)?.files ?? []);
  }, [chapters, orderedChapterIds]);

  return (
    <div className="flex flex-col gap-[18px]">
      {orderedFiles.map((file) => {
        const chapter = fileToChapter.get(file);
        const expanded = expandedFiles.has(file);
        const annotations = annotationsByFile.get(file) ?? [];
        const patch = patchByFile.get(file) ?? null;
        const stats = patch ? countStats(patch) : null;
        const active = file === activeFile;
        return (
          <FileCard
            key={file}
            file={file}
            chapterTitle={chapter?.title ?? ""}
            stats={stats}
            expanded={expanded}
            active={active}
            annotations={annotations}
            patch={patch}
            diffStyle={diffStyle}
            onToggle={() => {
              onSelectFile(file);
              onToggleExpand(file);
            }}
            registerRef={(el) => {
              if (el) fileRefs.current.set(file, el);
              else fileRefs.current.delete(file);
            }}
          />
        );
      })}
    </div>
  );
}

interface FileCardProps {
  file: string;
  chapterTitle: string;
  stats: { adds: number; dels: number } | null;
  expanded: boolean;
  active: boolean;
  annotations: PrReviewAnnotation[];
  patch: string | null;
  diffStyle: "split" | "unified";
  onToggle: () => void;
  registerRef: (el: HTMLElement | null) => void;
}

function FileCard({
  file,
  chapterTitle,
  stats,
  expanded,
  active,
  annotations,
  patch,
  diffStyle,
  onToggle,
  registerRef,
}: FileCardProps) {
  const Icon = file.endsWith(".ts") || file.endsWith(".tsx") || file.endsWith(".js") ? FileCode : FileText;
  const Chev = expanded ? ChevronUp : ChevronDown;
  return (
    <section
      ref={registerRef}
      className={cn(
        "scroll-mt-24 overflow-hidden rounded-xl border bg-bg transition-colors",
        active ? "border-accent-dim" : "border-glass-border",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-[10px] px-4 text-left transition-colors",
          expanded ? "bg-bg-active py-[10px]" : "h-11 hover:bg-glass",
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-text-dim" strokeWidth={1.5} />
        <span className="min-w-0 truncate font-mono text-[12px] text-text">{file}</span>
        {stats && (
          <span className="shrink-0 font-mono text-[11px] text-text-ghost">
            +{stats.adds} −{stats.dels}
          </span>
        )}
        {chapterTitle && (
          <span className="shrink-0 rounded-[4px] bg-accent-ghost px-2 py-[2px] font-body text-[9px] font-normal uppercase tracking-[0.12em] text-accent">
            {chapterTitle}
          </span>
        )}
        {!expanded && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-text-void">
            click to expand
          </span>
        )}
        <Chev
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-text-ghost",
            expanded ? "ml-auto" : "",
          )}
          strokeWidth={1.5}
        />
      </button>
      {expanded && (
        <div className="border-t border-glass-border">
          <FileDiff
            filePath={file}
            patch={patch}
            annotations={annotations}
            diffStyle={diffStyle}
          />
        </div>
      )}
    </section>
  );
}

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
