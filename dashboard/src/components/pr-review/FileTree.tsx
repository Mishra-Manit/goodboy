/** Left rail: chapter sections with uppercase labels and file rows. */

import { cn, filenameTail } from "@dashboard/lib/utils";
import type { PrReviewAnnotation, PrReviewChapter } from "@dashboard/shared";

interface FileTreeProps {
  chapters: PrReviewChapter[];
  activeFile: string | null;
  onSelectFile: (file: string) => void;
}

export function FileTree({ chapters, activeFile, onSelectFile }: FileTreeProps) {
  return (
    <nav aria-label="Files" className="flex flex-col gap-4 px-3 py-3">
      {chapters.map((chapter) => (
        <ChapterSection
          key={chapter.id}
          chapter={chapter}
          activeFile={activeFile}
          onSelectFile={onSelectFile}
        />
      ))}
    </nav>
  );
}

// --- Chapter ---

interface ChapterSectionProps {
  chapter: PrReviewChapter;
  activeFile: string | null;
  onSelectFile: (file: string) => void;
}

function ChapterSection({ chapter, activeFile, onSelectFile }: ChapterSectionProps) {
  return (
    <section className="flex flex-col">
      <header className="mb-1.5 px-3">
        <h3 className="truncate font-mono text-[10.5px] font-medium uppercase tracking-[0.16em] text-text-secondary">
          {chapter.title}
        </h3>
      </header>
      <ul className="flex flex-col">
        {chapter.files.map(({ path }) => (
          <FileRow
            key={path}
            file={path}
            annotations={chapter.annotations.filter((a) => a.filePath === path)}
            active={path === activeFile}
            onSelect={onSelectFile}
          />
        ))}
      </ul>
    </section>
  );
}

// --- File row ---

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
  const total = concerns + fixes + notes;
  const totalColor = concerns > 0 ? "text-fail" : fixes > 0 ? "text-warn" : "text-info";

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(file)}
        title={file}
        className={cn(
          "group relative flex w-full items-center justify-between gap-2 py-[5px] pl-3 pr-2 text-left transition-colors",
          active
            ? "bg-glass text-text"
            : "text-text-secondary hover:bg-glass/60 hover:text-text",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-1/2 h-3.5 w-px -translate-y-1/2 transition-colors",
            active ? "bg-accent" : "bg-transparent",
          )}
        />
        <span className="min-w-0 truncate font-mono text-[11px]">
          {filenameTail(file)}
        </span>
        {total > 0 && (
          <span className={cn("shrink-0 font-mono text-[10px] tabular-nums", totalColor)}>
            {total}
          </span>
        )}
      </button>
    </li>
  );
}
