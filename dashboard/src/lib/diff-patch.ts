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

