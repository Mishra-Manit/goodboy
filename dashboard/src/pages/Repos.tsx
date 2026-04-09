import { FolderGit2, ExternalLink } from "lucide-react";
import { fetchRepos, type Repo } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { Card } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";

export function Repos() {
  const { data: repos, loading } = useQuery(() => fetchRepos());

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <FolderGit2 size={18} className="text-zinc-500" />
          <h1 className="text-lg font-semibold text-zinc-100">Repositories</h1>
        </div>
        <p className="text-sm text-zinc-500">
          Repos registered via REGISTERED_REPOS in .env
        </p>
      </div>

      {loading && !repos ? (
        <div className="text-sm text-zinc-500">Loading...</div>
      ) : (repos ?? []).length === 0 ? (
        <EmptyState
          icon={<FolderGit2 size={32} />}
          title="No repos registered"
          description="Add repos to the database to get started"
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(repos ?? []).map((repo) => (
            <RepoCard key={repo.name} repo={repo} />
          ))}
        </div>
      )}
    </div>
  );
}

function RepoCard({ repo }: { repo: Repo }) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2">
          <FolderGit2 size={16} className="text-violet-400/60" />
          <span className="text-sm font-medium text-zinc-200">{repo.name}</span>
        </div>
        {repo.githubUrl && (
          <a
            href={repo.githubUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ExternalLink size={11} />
            GitHub
          </a>
        )}
      </div>
      <code className="text-xs text-zinc-600 bg-zinc-900 rounded px-2 py-1">
        {repo.localPath}
      </code>
    </Card>
  );
}
