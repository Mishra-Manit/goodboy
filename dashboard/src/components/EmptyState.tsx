/** Centered "nothing here" copy. Use inside `<PageState empty={...}>` or on its own. */

interface EmptyStateProps {
  title: string;
  description?: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <p className="font-display text-sm font-medium text-text-ghost">{title}</p>
      {description && (
        <p className="mt-2 font-body text-xs text-text-void max-w-xs leading-relaxed">
          {description}
        </p>
      )}
    </div>
  );
}
