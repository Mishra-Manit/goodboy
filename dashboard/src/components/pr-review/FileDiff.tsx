/** Code diff panel. Renders a unified diff patch for one file. No annotation logic. */

import { useMemo } from "react";
import { PatchDiff } from "@pierre/diffs/react";

interface FileDiffProps {
  filePath: string;
  patch: string | null;
  diffStyle: "split" | "unified";
}

export function FileDiff({ filePath, patch, diffStyle }: FileDiffProps) {
  const options = useMemo(
    () => ({
      diffStyle,
      theme: "github-dark-high-contrast" as const,
      themeType: "dark" as const,
      overflow: "scroll" as const,
      lineDiffType: "word" as const,
      disableFileHeader: true,
      hunkSeparators: "simple" as const,
    }),
    [diffStyle],
  );

  if (!patch) {
    return (
      <div className="p-4 font-mono text-[11px] italic text-text-dim">
        diff unavailable for {filePath}
      </div>
    );
  }

  return (
    <section className="overflow-hidden bg-bg-raised">
      <PatchDiff patch={patch} options={options} />
    </section>
  );
}
