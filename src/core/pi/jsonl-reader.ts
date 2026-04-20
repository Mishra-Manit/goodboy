/**
 * Proper JSONL reader -- splits only on \n, not Unicode line separators.
 * Handles chunk boundaries, \r\n line endings, and flushes any trailing
 * partial line when the stream ends.
 */
export function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): void {
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
    }
  });
}
