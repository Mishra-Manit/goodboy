/** Shared error message block for failed tasks/runs. */

interface ErrorBlockProps {
  message: string;
}

export function ErrorBlock({ message }: ErrorBlockProps) {
  return (
    <div className="mb-6 rounded-md bg-fail-dim px-4 py-3">
      <span className="font-mono text-[10px] text-fail/80 block mb-0.5">error</span>
      <p className="font-mono text-[11px] text-fail/70 whitespace-pre-wrap">{message}</p>
    </div>
  );
}
