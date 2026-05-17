/** Safe relative artifact paths used by DB-backed canonical outputs. */

const UNSAFE_SEGMENTS = new Set(["", ".", ".."]);

/** Accept nested relative paths, reject absolute paths, traversal, and hidden path segments. */
export function isSafeArtifactFilePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/") || filePath.startsWith("~")) return false;
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts.every((part) => !UNSAFE_SEGMENTS.has(part) && !part.startsWith("."));
}

/** Normalize separators after safety validation. */
export function normalizeArtifactFilePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (!isSafeArtifactFilePath(normalized)) throw new Error(`Unsafe artifact file path: ${filePath}`);
  return normalized;
}
