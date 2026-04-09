import { cn } from "@dashboard/lib/utils";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
}

export function Card({ children, className, onClick, hoverable }: CardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "rounded-lg border border-zinc-800/60 bg-zinc-900/50 p-4",
        hoverable &&
          "cursor-pointer transition-all duration-150 hover:border-zinc-700/60 hover:bg-zinc-900/80",
        className
      )}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className }: CardHeaderProps) {
  return (
    <div className={cn("mb-2.5 flex items-center justify-between", className)}>
      {children}
    </div>
  );
}
