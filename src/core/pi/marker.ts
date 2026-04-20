import type { PiOutputMarker } from "../../shared/types.js";

/** Extract the trailing JSON completion marker from pi output. Line-based to avoid regex false-positives. */
export function extractMarker(text: string): PiOutputMarker | null {
  const lines = text.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.status === "complete") {
        return parsed as PiOutputMarker;
      }
    } catch { /* not JSON */ }
  }
  return null;
}
