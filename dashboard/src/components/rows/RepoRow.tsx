/** One registered repo, shown on the Repos page. Renders a memory status block. */

import { ExternalLink } from "lucide-react";
import { fetchMemoryStatus } from "@dashboard/lib/api";
import type { RepoSummary, MemoryStatus, MemoryStatusKind } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { timeAgo } from "@dashboard/lib/format";
import { cn } from "@dashboard/lib/utils";

interface RepoRowProps {
  repo: RepoSummary;
}

export function RepoRow({ repo }: RepoRowProps) {
  const { data: memory } = useQuery(`repo-memory:${repo.name}`, () => fetchMemoryStatus(repo.name));

  return (
    <div className="group rounded-lg bg-glass px-4 py-3.5 animate-fade-up">
      <div className="flex items-center justify-between mb-2">
        <span className="font-display text-sm font-medium text-text">{repo.name}</span>
        {repo.githubUrl && (
          <a
            href={repo.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
          >
            <ExternalLink size={10} />
            github
          </a>
        )}
      </div>
      {memory && <MemoryBlock memory={memory} />}
    </div>
  );
}

// --- Memory block ---

const STATUS_TONE: Record<MemoryStatusKind, string> = {
  fresh: "text-accent",
  stale: "text-warn",
  missing: "text-fail",
};

function MemoryBlock({ memory }: { memory: MemoryStatus }) {
  return (
    <div className="mt-3 border-t border-glass-border pt-2.5 space-y-1.5">
      <div className="flex items-center gap-2 font-mono text-[10px]">
        <span className="text-text-ghost">memory</span>
        <span className={cn("uppercase tracking-wider", STATUS_TONE[memory.status])}>
          {memory.status}
        </span>
        {memory.lastIndexedSha && (
          <span className="text-text-void">{memory.lastIndexedSha.slice(0, 8)}</span>
        )}
        {memory.lastIndexedAt && (
          <span className="text-text-ghost">{timeAgo(memory.lastIndexedAt)}</span>
        )}
        {memory.status !== "missing" && (
          <span className="text-text-void">
            {memory.fileCount} file{memory.fileCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {memory.zones.length > 0 && (
        <ul className="space-y-0.5">
          {memory.zones.map((zone) => (
            <li key={zone.name} className="font-mono text-[10px] text-text-void">
              <span className="text-text-ghost">{zone.name}</span>
              <span className="mx-1.5 text-text-void">·</span>
              <code className="text-text-void">{zone.path}</code>
              <span className="mx-1.5 text-text-void">·</span>
              <span className="text-text-ghost">{zone.summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
