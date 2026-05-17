/** Hash canonical artifact content so DB rows can be compared with local files. */

import { createHash } from "node:crypto";

/** Compute the sha256 digest for UTF-8 text. */
export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Stable pretty JSON representation used for DB-backed JSON artifacts. */
export function canonicalJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
