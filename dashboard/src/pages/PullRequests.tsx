import { ExternalLink, ArrowUpRight } from "lucide-react";
import { fetchPRs, type PR } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { shortId } from "@dashboard/lib/utils";
import { useNavigate } from "react-router-dom";

export function PullRequests() {
  const navigate = useNavigate();
  const { data: prs, loading, refetch } = useQuery(() => fetchPRs());

  useSSERefresh(refetch, (e) => e.type === "pr_update" || e.type === "task_update");

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">
          Pull Requests
        </h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          PRs created by goodboy across all repos
        </p>
      </header>

      {loading && !prs ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
            loading...
          </span>
        </div>
      ) : (prs ?? []).length === 0 ? (
        <EmptyState
          title="No pull requests"
          description="PRs will appear here after tasks create them"
        />
      ) : (
        <>
          <SectionDivider label="open" detail={`${(prs ?? []).length}`} />
          <div className="mt-3 space-y-0.5 stagger">
            {(prs ?? []).map((pr) => (
              <PRRow
                key={pr.taskId}
                pr={pr}
                onTaskClick={() => navigate(`/tasks/${pr.taskId}`)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function PRRow({
  pr,
  onTaskClick,
}: {
  pr: PR;
  onTaskClick: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-glass animate-fade-up">
      <span className="font-mono text-[10px] text-accent/60">{pr.repo}</span>

      <button
        onClick={onTaskClick}
        className="flex items-center gap-0.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors"
      >
        {shortId(pr.taskId)}
        <ArrowUpRight size={9} />
      </button>

      {pr.prNumber && (
        <span className="font-mono text-[11px] text-text-dim">
          #{pr.prNumber}
        </span>
      )}

      <span className="flex-1" />

      <StatusBadge status={pr.status} />

      {pr.prUrl && (
        <a
          href={pr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
        >
          <ExternalLink size={10} />
          view
        </a>
      )}
    </div>
  );
}
