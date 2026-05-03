/**
 * Pure helpers for creating deterministic PR diff file-order variants.
 * Shuffles whole `diff --git` blocks only; hunks inside a file stay intact.
 */

export interface DiffVariant {
  variant: number;
  diff: string;
  fileOrder: string[];
}

// --- Public API ---

/** Split a unified git diff into preamble plus per-file blocks. */
export function splitDiffByFile(diff: string): { preamble: string; blocks: string[] } {
  const starts = [...diff.matchAll(/^diff --git .*$/gm)].map((match) => match.index ?? 0);
  if (starts.length === 0) return { preamble: diff, blocks: [] };

  const preamble = diff.slice(0, starts[0]);
  const blocks = starts.map((start, index) => {
    const end = starts[index + 1] ?? diff.length;
    return diff.slice(start, end);
  });
  return { preamble, blocks };
}

/** Best-effort path label for one `diff --git` block. */
export function fileBlockPath(block: string): string {
  const firstLine = block.split("\n", 1)[0] ?? "";
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(firstLine);
  return match?.[2] ?? firstLine.replace(/^diff --git\s+/, "").trim();
}

/** Deterministic 32-bit seed from arbitrary text. */
export function hashToSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Return a deterministically shuffled copy using Fisher-Yates + LCG. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const next = [...items];
  let state = seed || 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const current = next[i]!;
    const replacement = next[j]!;
    next[i] = replacement;
    next[j] = current;
  }
  return next;
}

/** Build canonical v1 plus deterministic shuffled variants for multi-file diffs. */
export function permuteDiff(diff: string, taskId: string, variantCount: number): DiffVariant[] {
  const { preamble, blocks } = splitDiffByFile(diff);
  if (blocks.length === 0) return [{ variant: 1, diff, fileOrder: [] }];

  const count = Math.max(1, Math.floor(variantCount));
  return Array.from({ length: count }, (_, index) => {
    const variant = index + 1;
    const orderedBlocks = variant === 1 || blocks.length === 1
      ? [...blocks]
      : seededShuffle(blocks, hashToSeed(`${taskId}:pr-impact:v${variant}`));
    return {
      variant,
      diff: `${preamble}${orderedBlocks.join("")}`,
      fileOrder: orderedBlocks.map(fileBlockPath),
    };
  });
}
