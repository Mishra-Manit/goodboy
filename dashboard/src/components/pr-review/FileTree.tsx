/** Left rail: chapter sections with uppercase labels and file rows. Matches V8 stack design. */

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
    <nav aria-label="Files" className="flex h-full flex-col bg-bg">
      {orderedChapterIds.map((id) => {
        const chapter = byId.get(id);
        if (!chapter) return null;
        return (
          <ChapterSection
            key={id}
            chapter={chapter}
            activeFile={activeFile}
            onSelectFile={onSelectFile}
          />
        );
      })}
    </nav>
  );
}

interface ChapterSectionProps {
  chapter: PrReviewChapter;
  activeFile: string | null;
  onSelectFile: (file: string) => void;
}

function ChapterSection({ chapter, activeFile, onSelectFile }: ChapterSectionProps) {
  const fileCount = chapter.files.length;
  return (
    <div className="flex flex-col gap-[6px] px-[14px] pb-3 pt-5">
      <h3 className="font-body text-[11px] font-bold tracking-[0.18em] text-text-dim">
        {chapter.title.toUpperCase()}
        <span className="text-text-void">
          {"  ·  "}
          {fileCount} {fileCount === 1 ? "FILE" : "FILES"}
        </span>
      </h3>
      <ul className="flex flex-col gap-[6px]">
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
  const total = concerns + fixes + notes;
  const totalColor =
    concerns > 0 ? "text-fail" : fixes > 0 ? "text-warn" : "text-info";

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(file)}
        className={cn(
          "flex w-full items-center gap-[6px] rounded-md px-3 py-[10px] text-left transition-colors",
          active
            ? "border-l-2 border-l-accent bg-accent-ghost pl-[10px]"
            : "border-l-2 border-l-transparent text-text-dim hover:bg-glass hover:text-text-secondary",
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate font-mono text-[13px]",
            active ? "text-accent" : "",
          )}
        >
          {filenameOnly(file)}
        </span>
        {total > 0 && (
          <span className={cn("ml-auto font-mono text-[11px] font-bold tabular-nums", totalColor)}>
            {total}
          </span>
        )}
      </button>
    </li>
  );
}

function filenameOnly(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
