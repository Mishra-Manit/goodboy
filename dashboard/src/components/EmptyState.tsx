import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      {icon && <div className="mb-4 text-zinc-700">{icon}</div>}
      <h3 className="text-sm font-medium text-zinc-500">{title}</h3>
      {description && (
        <p className="mt-1.5 text-xs text-zinc-600 max-w-xs">{description}</p>
      )}
    </div>
  );
}
