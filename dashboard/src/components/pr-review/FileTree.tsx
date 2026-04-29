/** Left rail: chapters as collapsible groups, files with concern/fix dots. */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation, PrReviewChapter } from "@dashboard/shared";

interface FileTreeProps {
  chapters: PrReviewChapter[];
  orderedChapterIds: string[];
  activeFile: string | null;
  onSelectFile: (file: string) => void;
}

export function FileTree({ chapters, orderedChapterIds, activeFile, onSelectFile }: FileTreeProps) {
  const byId = new Map(chapters.map((c) => [c.id, c]));
  return (
    <nav aria-label="Files" className="space-y-4">
      {orderedChapterIds.map((id, index) => {
        const chapter = byId.get(id);
        if (!chapter) return null;
        return (
          <ChapterGroup
            key={id}
            index={index}
            chapter={chapter}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
          />
        );
      })}
    </nav>
  );
}

// --- Helpers ---

interface ChapterGroupProps {
  index: number;
  chapter: PrReviewChapter;
  activeFile: string | null;
  onSelectFile: (file: string) => void;
}

function ChapterGroup({ index, chapter, activeFile, onSelectFile }: ChapterGroupProps) {
  const containsActive = activeFile !== null && chapter.files.includes(activeFile);
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 self-center text-text-void" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 self-center text-text-void" />
        )}
        <span className="font-mono text-[10px] tabular-nums text-text-void">
          {String(index + 1).padStart(2, "0")}
        </span>
        <span
          className={cn(
            "font-display text-[12px] uppercase tracking-[0.08em]",
            containsActive ? "text-text" : "text-text-dim",
          )}
        >
          {chapter.title}
        </span>
      </button>

      {open && (
        <ul className="mt-1 space-y-0.5 pl-5">
          {chapter.files.map((file) => (
            <FileRow
              key={file}
              file={file}
              annotations={chapter.annotations.filter((a) => a.filePath === file)}
              active={file === activeFile}
              onSelect={onSelectFile}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface FileRowProps {
  file: string;
  annotations: PrReviewAnnotation[];
  active: boolean;
  onSelect: (file: string) => void;
}

function FileRow({ file, annotations, active, onSelect }: FileRowProps) {
  const concerns = annotations.filter((a) => a.kind === "concern").length;
  const fixes = annotations.filter((a) => a.kind === "goodboy_fix").length;
  const notes = annotations.filter((a) => a.kind === "note").length;

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(file)}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm border-l-2 py-1 pl-2 pr-1 text-left transition-colors",
          active
            ? "border-l-accent bg-accent-ghost text-text"
            : "border-l-transparent text-text-dim hover:border-l-glass-border hover:bg-glass hover:text-text-secondary",
        )}
      >
        <span className="truncate font-mono text-[11px]">{filenameOnly(file)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {concerns > 0 && <Dot className="bg-fail" count={concerns} />}
          {fixes > 0 && <Dot className="bg-accent" count={fixes} />}
          {notes > 0 && <Dot className="bg-info" count={notes} />}
        </span>
      </button>
    </li>
  );
}

function Dot({ className, count }: { className: string; count: number }) {
  return (
    <span className="flex items-center gap-0.5">
      <span className={cn("h-1.5 w-1.5 rounded-full", className)} />
      {count > 1 && (
        <span className="font-mono text-[9px] tabular-nums text-text-void">{count}</span>
      )}
    </span>
  );
}

function filenameOnly(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
