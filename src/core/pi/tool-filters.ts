/**
 * Pure filters for tool events: detect raw tool JSON leaking into the text
 * stream (duplicates the structured event) and truncate long string args
 * for display. Imported by `session.ts` to keep the event router clean.
 */

/** True if `text` is a JSON-encoded tool event that duplicates a structured log entry. */
export function isRawToolEvent(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    const obj = JSON.parse(text);
    return (
      typeof obj === "object" &&
      obj !== null &&
      typeof obj.type === "string" &&
      (obj.type === "tool_execution_end" ||
        obj.type === "tool_execution_start" ||
        obj.type === "tool_call")
    );
  } catch {
    return false;
  }
}

/** Cap long string argument values at 300 chars so the dashboard stays responsive. */
export function truncateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 300) {
      result[key] = value.slice(0, 300) + "...";
    } else {
      result[key] = value;
    }
  }
  return result;
}
