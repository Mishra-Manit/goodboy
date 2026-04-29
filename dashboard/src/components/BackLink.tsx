/** "← back" link at the top of a detail page. */

import { ArrowLeft } from "lucide-react";

interface BackLinkProps {
  label: string;
  onClick: () => void;
}

export function BackLink({ label, onClick }: BackLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-6 flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors"
    >
      <ArrowLeft size={12} />
      {label}
    </button>
  );
}
