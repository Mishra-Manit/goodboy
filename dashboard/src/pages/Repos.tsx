import { FolderGit2 } from "lucide-react";
import { fetchRepos, type Repo } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { Card } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";
import { formatDate } from "@dashboard/lib/utils";

export function Repos() {
  const { data: repos, loading } = useQuery(() => fetchRepos());

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold">Repositories</h1>
        <p className="text-sm text-text-muted">
          Registered repos that Goodboy can work on
        </p>
      </div>

      {loading && !repos ? (
        <div className="text-sm text-text-muted">Loading...</div>
      ) : (repos ?? []).length === 0 ? (
        <EmptyState
          icon={<FolderGit2 size={32} />}
          title="No repos registered"
          description="Add repos to the database to get started"
        />
      ) : (
        <div className="space-y-2">
          {(repos ?? []).map((repo) => (
            <RepoRow key={repo.name} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoRow({ repo }: { repo: Repo }) {
  return (
    <Card className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <FolderGit2 size={16} className="text-text-muted" />
          <span className="text-sm font-medium">{repo.name}</span>
          <code className="text-xs text-text-muted">{repo.localPath}</code>
        </div>
        <div className="flex items-center gap-3">
          {repo.githubUrl && (
            <a
              href={repo.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-text-muted hover:text-text transition-colors"
            >
              GitHub
            </a>
          )}
          <span className="text-xs text-text-muted">
            Added {formatDate(repo.createdAt)}
          </span>
        </div>
      </div>
    </Card>
  );
}
