/** Left rail: chapter sections with uppercase labels and file rows. */

import { ChevronDown, ChevronRight } from "lucide-react";
import { cn, filenameTail } from "@dashboard/lib/utils";
import type { PrReviewAnnotation, PrReviewChapter } from "@dashboard/shared";

interface FileTreeProps {
  chapters: PrReviewChapter[];
  activeFile: string | null;
  viewed: Set<string>;
  collapsed: Set<string>;
  onSelectFile: (file: string) => void;
  onToggleViewed: (file: string) => void;
  onToggleCollapse: (file: string) => void;
}

export function FileTree({
  chapters,
  activeFile,
  viewed,
  collapsed,
  onSelectFile,
  onToggleViewed,
  onToggleCollapse,
}: FileTreeProps) {
  return (
    <nav aria-label="Files" className="flex flex-col gap-4 px-3 py-3">
      {chapters.map((chapter) => (
        <ChapterSection
          key={chapter.id}
          chapter={chapter}
          activeFile={activeFile}
          viewed={viewed}
          collapsed={collapsed}
          onSelectFile={onSelectFile}
          onToggleViewed={onToggleViewed}
          onToggleCollapse={onToggleCollapse}
        />
      ))}
    </nav>
  );
}

// --- Chapter ---

interface ChapterSectionProps {
  chapter: PrReviewChapter;
  activeFile: string | null;
  viewed: Set<string>;
  collapsed: Set<string>;
  onSelectFile: (file: string) => void;
  onToggleViewed: (file: string) => void;
  onToggleCollapse: (file: string) => void;
}

function ChapterSection({
  chapter,
  activeFile,
  viewed,
  collapsed,
  onSelectFile,
  onToggleViewed,
  onToggleCollapse,
}: ChapterSectionProps) {
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
            isViewed={viewed.has(path)}
            isCollapsed={collapsed.has(path)}
            onSelect={onSelectFile}
            onToggleViewed={onToggleViewed}
            onToggleCollapse={onToggleCollapse}
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
  isViewed: boolean;
  isCollapsed: boolean;
  onSelect: (file: string) => void;
  onToggleViewed: (file: string) => void;
  onToggleCollapse: (file: string) => void;
}

function FileRow({
  file,
  annotations,
  active,
  isViewed,
  isCollapsed,
  onSelect,
  onToggleViewed,
  onToggleCollapse,
}: FileRowProps) {
  const concerns = annotations.filter((a) => a.kind === "concern").length;
  const fixes = annotations.filter((a) => a.kind === "goodboy_fix").length;
  const notes = annotations.filter((a) => a.kind === "note").length;
  const total = concerns + fixes + notes;
  const totalColor = concerns > 0 ? "text-fail" : fixes > 0 ? "text-warn" : "text-info";

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={() => onSelect(file)}
        title={file}
        className={cn(
          "relative flex w-full items-center gap-1.5 py-[5px] pl-1.5 pr-2 text-left transition-colors",
          active
            ? "bg-glass text-text"
            : isViewed
              ? "text-text-ghost hover:bg-glass/40 hover:text-text-dim"
              : "text-text-secondary hover:bg-glass/60 hover:text-text",
        )}
      >
        {/* Collapse chevron */}
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(file); }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-glass"
        >
          {isCollapsed
            ? <ChevronRight size={10} className="text-text-ghost" />
            : <ChevronDown size={10} className="text-text-ghost" />
          }
        </span>

        {/* Active indicator */}
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-1/2 h-3.5 w-px -translate-y-1/2 transition-colors",
            active ? "bg-accent" : "bg-transparent",
          )}
        />

        {/* Filename */}
        <span className="min-w-0 truncate font-mono text-[11px]">
          {filenameTail(file)}
        </span>

        {/* Right side: viewed checkbox + annotation count */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <input
            type="checkbox"
            checked={isViewed}
            onChange={(e) => { e.stopPropagation(); onToggleViewed(file); }}
            onClick={(e) => e.stopPropagation()}
            className="h-3 w-3 cursor-pointer appearance-none rounded-sm border border-text-ghost bg-transparent transition-colors checked:border-accent checked:bg-accent/20"
            title={isViewed ? "Mark as unviewed" : "Mark as viewed"}
          />
          {total > 0 && (
            <span className={cn("font-mono text-[10px] tabular-nums", totalColor)}>
              {total}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
