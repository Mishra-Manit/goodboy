/** Glass card with optional click + live accent. */

import type { ReactNode } from "react";
import { cn } from "@dashboard/lib/utils";

interface CardProps {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  hoverable?: boolean;
  /** Adds the amber left-edge glow for active/live items. */
  live?: boolean;
}

export function Card({ children, className, onClick, hoverable, live }: CardProps) {
  const classes = cn(
    "relative rounded-lg px-4 py-3.5 transition-all duration-200",
    "bg-glass border border-glass-border",
    live && "live-glow",
    hoverable && "cursor-pointer hover:bg-glass-hover hover:border-glass-hover",
    className,
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
