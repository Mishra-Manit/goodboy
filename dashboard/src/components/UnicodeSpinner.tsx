/** Animated braille-grid spinner driven by the `unicode-animations` package.
 *  Replaces the legacy pulsing-dot indicator with a richer multi-char animation. */

import { useEffect, useState } from "react";
import spinners, { type BrailleSpinnerName } from "unicode-animations";
import { cn } from "@dashboard/lib/utils";

interface UnicodeSpinnerProps {
  name?: BrailleSpinnerName;
  className?: string;
}

export function UnicodeSpinner({ name = "scan", className }: UnicodeSpinnerProps) {
  const spinner = spinners[name];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    setFrame(0);
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % spinner.frames.length),
      spinner.interval,
    );
    return () => clearInterval(timer);
  }, [spinner]);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block whitespace-pre font-mono text-accent leading-none tabular-nums",
        className,
      )}
    >
      {spinner.frames[frame]}
    </span>
  );
}
