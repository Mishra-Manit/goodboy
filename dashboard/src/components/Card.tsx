import { cn } from "@dashboard/lib/utils";
import type { ReactNode } from "react";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
  /** Adds a left-edge accent glow for active/live items */
  live?: boolean;
}

export function Card({ children, className, onClick, hoverable, live }: CardProps) {
  const classes = cn(
    "relative rounded-lg px-4 py-3.5 transition-all duration-200",
    "bg-glass border border-glass-border",
    live && "border-l-accent/30 border-l-2 shadow-[inset_2px_0_12px_rgba(212,160,23,0.04)]",
    hoverable && "cursor-pointer hover:bg-glass-hover hover:border-glass-hover",
    className
  );

  if (onClick) {
    return (
      <button onClick={onClick} className={cn(classes, "w-full text-left")}>
        {children}
      </button>
    );
  }

  return <div className={classes}>{children}</div>;
}
