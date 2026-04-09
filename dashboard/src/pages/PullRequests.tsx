import { GitPullRequest, ExternalLink, ArrowUpRight } from "lucide-react";
import { fetchPRs, type PR } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { Card } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";
import { shortId } from "@dashboard/lib/utils";
import { useNavigate } from "react-router-dom";

export function PullRequests() {
  const navigate = useNavigate();
  const { data: prs, loading, refetch } = useQuery(() => fetchPRs());

  useSSERefresh(refetch, (e) => e.type === "pr_update" || e.type === "task_update");

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <GitPullRequest size={18} className="text-zinc-500" />
          <h1 className="text-lg font-semibold text-zinc-100">Pull Requests</h1>
        </div>
        <p className="text-sm text-zinc-500">
          PRs created by Goodboy across all repos
        </p>
      </div>

      {loading && !prs ? (
        <div className="text-sm text-zinc-500">Loading...</div>
      ) : (prs ?? []).length === 0 ? (
        <EmptyState
          icon={<GitPullRequest size={32} />}
          title="No pull requests"
          description="PRs will appear here after tasks create them"
        />
      ) : (
        <div className="space-y-2">
          {(prs ?? []).map((pr) => (
            <PRRow key={pr.taskId} pr={pr} onTaskClick={() => navigate(`/tasks/${pr.taskId}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function PRRow({ pr, onTaskClick }: { pr: PR; onTaskClick: () => void }) {
  return (
    <Card className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <GitPullRequest size={15} className="text-zinc-600" />
          <span className="text-xs font-medium text-violet-400">{pr.repo}</span>
          <button
            onClick={onTaskClick}
            className="text-xs text-zinc-500 hover:text-zinc-300 font-mono flex items-center gap-0.5 transition-colors"
          >
            {shortId(pr.taskId)}
            <ArrowUpRight size={10} />
          </button>
          {pr.prNumber && (
            <span className="text-sm text-zinc-400">#{pr.prNumber}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={pr.status} />
          {pr.prUrl && (
            <a
              href={pr.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <ExternalLink size={11} />
              View
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}
