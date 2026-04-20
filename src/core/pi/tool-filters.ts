/** Detect raw tool event JSON that leaks into the text stream (duplicates structured entries) */
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

/** Truncate long string argument values for display */
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
