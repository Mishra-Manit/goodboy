/** GitHub error alert banner. */

interface GitHubErrorProps {
  message: string;
}

export function GitHubError({ message }: GitHubErrorProps) {
  return (
    <div className="rounded-lg border border-fail/30 bg-glass px-4 py-3">
      <p className="font-mono text-[11px] text-fail">GitHub discovery failed</p>
      <p className="mt-1 font-mono text-[10px] text-text-ghost">{message}</p>
    </div>
  );
}
