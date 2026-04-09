import { GitPullRequest, ExternalLink } from "lucide-react";
import { fetchPRs, type PR } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { Card } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";
import { shortId } from "@dashboard/lib/utils";

export function PullRequests() {
  const { data: prs, loading, refetch } = useQuery(() => fetchPRs());

  useSSERefresh(refetch, (e) => e.type === "pr_update" || e.type === "task_update");

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold">Pull Requests</h1>
        <p className="text-sm text-text-muted">
          PRs created by Goodboy across all repos
        </p>
      </div>

      {loading && !prs ? (
        <div className="text-sm text-text-muted">Loading...</div>
      ) : (prs ?? []).length === 0 ? (
        <EmptyState
          icon={<GitPullRequest size={32} />}
          title="No pull requests"
          description="PRs will appear here after tasks create them"
        />
      ) : (
        <div className="space-y-2">
          {(prs ?? []).map((pr) => (
            <PRRow key={pr.taskId} pr={pr} />
          ))}
        </div>
      )}
    </div>
  );
}

function PRRow({ pr }: { pr: PR }) {
  return (
    <Card className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <GitPullRequest size={16} className="text-text-muted" />
          <span className="text-xs font-medium text-brand">{pr.repo}</span>
          <code className="text-xs text-text-muted">
            {shortId(pr.taskId)}
          </code>
          {pr.prNumber && (
            <span className="text-sm text-text-dim">#{pr.prNumber}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={pr.status} />
          {pr.prUrl && (
            <a
              href={pr.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
            >
              <ExternalLink size={12} />
              View PR
            </a>
          )}
        </div>
      </div>
    </Card>
  );
}
