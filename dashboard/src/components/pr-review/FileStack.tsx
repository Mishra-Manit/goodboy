/** Center scroll: overall summary, then for each chapter: group narrative header + 2-panel file cards. */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Check, FileCode, FileText } from "lucide-react";
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
  viewed: Set<string>;
  collapsed: Set<string>;
  diffStyle: "split" | "unified";
  fileRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
  onSelectFile: (file: string) => void;
  onToggleCollapse: (file: string) => void;
  onToggleViewed: (file: string) => void;
}

export function FileStack({
  summary,
  chapters,
  patchByFile,
  annotationsByFile,
  activeFile,
  viewed,
  collapsed,
  diffStyle,
  fileRefs,
  onReplyAnnotation,
  onSelectFile,
  onToggleCollapse,
  onToggleViewed,
}: FileStackProps) {
  return (
    <div className="flex flex-col gap-6">
      <OverallSummary summary={summary} patchByFile={patchByFile} />
      {chapters.map((chapter) => (
        <ChapterSection
          key={chapter.id}
          chapter={chapter}
          patchByFile={patchByFile}
          annotationsByFile={annotationsByFile}
          activeFile={activeFile}
          viewed={viewed}
          collapsed={collapsed}
          diffStyle={diffStyle}
          fileRefs={fileRefs}
          onReplyAnnotation={onReplyAnnotation}
          onSelectFile={onSelectFile}
          onToggleCollapse={onToggleCollapse}
          onToggleViewed={onToggleViewed}
        />
      ))}
    </div>
  );
}

// --- Overall Summary ---

function computeDiffStats(patchByFile: Map<string, string>) {
  let additions = 0;
  let deletions = 0;
  for (const patch of patchByFile.values()) {
    for (const line of patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }
  return { additions, deletions, filesChanged: patchByFile.size };
}

function OverallSummary({ summary, patchByFile }: { summary: string; patchByFile: Map<string, string> }) {
  const { additions, deletions, filesChanged } = computeDiffStats(patchByFile);
  return (
    <section className="rounded-xl border border-accent-dim bg-bg px-5 py-4">
      <div className="mb-2 flex items-center gap-3">
        <h2 className="font-display text-[15px] font-medium text-text">
          Overall PR diff
        </h2>
        <div className="flex items-center gap-2 font-mono text-[12px]">
          <span className="text-text-secondary">{filesChanged} file{filesChanged !== 1 ? "s" : ""}</span>
          <span className="text-green-400">+{additions}</span>
          <span className="text-red-400">-{deletions}</span>
        </div>
      </div>
      <p className="font-body text-[12.5px] leading-[1.75] text-text-secondary">{summary}</p>
    </section>
  );
}

// --- Chapter Section ---

interface ChapterSectionProps {
  chapter: PrReviewChapter;
  patchByFile: Map<string, string>;
  annotationsByFile: Map<string, PrReviewAnnotation[]>;
  activeFile: string | null;
  viewed: Set<string>;
  collapsed: Set<string>;
  diffStyle: "split" | "unified";
  fileRefs: React.MutableRefObject<Map<string, HTMLElement>>;
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
  onSelectFile: (file: string) => void;
  onToggleCollapse: (file: string) => void;
  onToggleViewed: (file: string) => void;
}

function ChapterSection({
  chapter,
  patchByFile,
  annotationsByFile,
  activeFile,
  viewed,
  collapsed,
  diffStyle,
  fileRefs,
  onReplyAnnotation,
  onSelectFile,
  onToggleCollapse,
  onToggleViewed,
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
          isViewed={viewed.has(file.path)}
          isCollapsed={collapsed.has(file.path)}
          diffStyle={diffStyle}
          onReplyAnnotation={onReplyAnnotation}
          onToggleCollapse={onToggleCollapse}
          onToggleViewed={onToggleViewed}
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
      <p className="font-body text-[12.5px] leading-[1.7] text-text-secondary">{narrative}</p>
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
  isViewed: boolean;
  isCollapsed: boolean;
  diffStyle: "split" | "unified";
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
  onToggleCollapse: (file: string) => void;
  onToggleViewed: (file: string) => void;
  registerRef: (el: HTMLElement | null) => void;
  onFocus: () => void;
}

function FileCard({
  filePath,
  fileNarrative,
  patch,
  annotations,
  active,
  isViewed,
  isCollapsed,
  diffStyle,
  onReplyAnnotation,
  onToggleCollapse,
  onToggleViewed,
  registerRef,
  onFocus,
}: FileCardProps) {
  const stats = patch ? countStats(patch) : null;
  const Icon = isCode(filePath) ? FileCode : FileText;
  const Chevron = isCollapsed ? ChevronRight : ChevronDown;

  return (
    <section
      ref={registerRef}
      onClick={onFocus}
      className={cn(
        "scroll-mt-24 overflow-hidden rounded-xl border bg-bg transition-colors",
        active ? "border-accent-dim" : "border-glass-border",
        isViewed && !active && "opacity-70",
      )}
    >
      <div className="flex h-10 items-center gap-[10px] bg-bg-active px-4">
        {/* Collapse toggle */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(filePath); }}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-glass"
          aria-label={isCollapsed ? "Expand file" : "Collapse file"}
        >
          <Chevron size={12} className="text-text-ghost" />
        </button>

        <Icon className="h-3.5 w-3.5 shrink-0 text-text-ghost" strokeWidth={1.5} />
        <span className="min-w-0 truncate font-mono text-[12px] text-text">{filePath}</span>

        {/* Right side: viewed badge + stats */}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {isViewed && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleViewed(filePath); }}
              className="flex items-center gap-1 rounded-full bg-accent-ghost px-1.5 py-0.5 font-mono text-[9px] text-accent/80 transition-colors hover:text-accent"
              title="Mark as unviewed"
            >
              <Check size={8} />
              viewed
            </button>
          )}
          {!isViewed && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleViewed(filePath); }}
              className="rounded-full px-1.5 py-0.5 font-mono text-[9px] text-text-void transition-colors hover:bg-glass hover:text-text-ghost"
              title="Mark as viewed"
            >
              mark viewed
            </button>
          )}
          {stats && (
            <span className="font-mono text-[10px] tabular-nums">
              <span className="text-green-400">+{stats.adds}</span>{" "}
              <span className="text-red-400">−{stats.dels}</span>
            </span>
          )}
        </span>
      </div>

      {/* Collapsible content with CSS grid transition */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          isCollapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
      >
        <div className="overflow-hidden">
          <ResizableFileContent
            narrative={fileNarrative}
            annotations={annotations}
            filePath={filePath}
            patch={patch}
            diffStyle={diffStyle}
            onReplyAnnotation={onReplyAnnotation}
          />
        </div>
      </div>
    </section>
  );
}

// --- Resizable File Content ---

const STORAGE_KEY = "pr-review:file-split";
const DEFAULT_RATIO = 0.38; // NL panel gets ~38% by default
const MIN_RATIO = 0.2;
const MAX_RATIO = 0.6;

function loadRatio(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RATIO;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(MIN_RATIO, Math.min(MAX_RATIO, parsed)) : DEFAULT_RATIO;
  } catch {
    return DEFAULT_RATIO;
  }
}

function saveRatio(ratio: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(ratio.toFixed(4)));
  } catch { /* ignore */ }
}

// Module-level shared state so all FileCards share the same split
let _sharedListeners: Set<(r: number) => void> = new Set();
let _sharedRatio: number = loadRatio();

function subscribeRatio(listener: (r: number) => void): () => void {
  _sharedListeners.add(listener);
  return () => { _sharedListeners.delete(listener); };
}

function broadcastRatio(ratio: number): void {
  const clamped = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
  _sharedRatio = clamped;
  saveRatio(clamped);
  for (const fn of _sharedListeners) fn(clamped);
}

function useSyncedRatio(): [number, (r: number) => void] {
  const [ratio, setRatio] = useState(_sharedRatio);
  useEffect(() => {
    const unsub = subscribeRatio(setRatio);
    return unsub;
  }, []);
  return [ratio, broadcastRatio];
}

interface ResizableFileContentProps {
  narrative: string;
  annotations: PrReviewAnnotation[];
  filePath: string;
  patch: string | null;
  diffStyle: "split" | "unified";
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
}


function ResizableFileContent({
  narrative,
  annotations,
  filePath,
  patch,
  diffStyle,
  onReplyAnnotation,
}: ResizableFileContentProps) {
  const [ratio, setRatio] = useSyncedRatio();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: PointerEvent) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = ev.clientX - rect.left;
      const proposed = x / rect.width;
      setRatio(proposed);
    }
    function onUp() {
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [setRatio]);

  const leftPercent = `${(ratio * 100).toFixed(2)}%`;
  const rightPercent = `${((1 - ratio) * 100).toFixed(2)}%`;

  return (
    <div
      ref={containerRef}
      className="relative flex border-t border-glass-border bg-bg-raised"
    >
      {/* NL panel */}
      <div style={{ width: leftPercent }} className="min-w-0 shrink-0 overflow-hidden">
        <NlFilePanel
          narrative={narrative}
          annotations={annotations}
          patch={patch}
          onReplyAnnotation={onReplyAnnotation}
        />
      </div>

      {/* Drag handle */}
      <div
        onPointerDown={onPointerDown}
        onDoubleClick={() => setRatio(DEFAULT_RATIO)}
        className="group relative z-10 w-0 cursor-col-resize select-none"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-0 w-px transition-colors",
            dragging ? "bg-accent" : "bg-glass-border group-hover:bg-text-ghost",
          )}
        />
        {/* Wider invisible hit area */}
        <div className="absolute inset-y-0 -left-[4px] w-[9px]" />
      </div>

      {/* Code diff panel */}
      <div style={{ width: rightPercent }} className="min-w-0 overflow-hidden">
        <FileDiff filePath={filePath} patch={patch} diffStyle={diffStyle} />
      </div>
    </div>
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
