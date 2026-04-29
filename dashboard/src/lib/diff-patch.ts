/**
 * Split a unified diff string into one entry per file. Pure -- no IO.
 */

export interface FilePatch {
  filePath: string;
  patch: string;
}

const DIFF_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/m;

// --- Public API ---

/** Return one patch section per `diff --git` file header. */
export function splitUnifiedDiffByFile(diffPatch: string): FilePatch[] {
  if (!diffPatch.trim()) return [];
  const sections = diffPatch.split(/(?=^diff --git )/m).filter((section) => section.trim());
  return sections.flatMap((section) => {
    const match = section.match(DIFF_HEADER_RE);
    if (!match) return [];
    const filePath = match[2] ?? match[1];
    return [{ filePath, patch: section }];
  });
}

/** Find the patch section for a single post-change file path. */
export function findPatchForFile(diffPatch: string, filePath: string): string | null {
  return splitUnifiedDiffByFile(diffPatch).find((patch) => patch.filePath === filePath)?.patch ?? null;
}
