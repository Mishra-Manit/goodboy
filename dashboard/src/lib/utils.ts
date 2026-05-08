/** Tiny view helpers. Formatters live in `format.ts`; this file stays minimal. */

import { clsx, type ClassValue } from "clsx";
export { shortId } from "@dashboard/shared";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/** Returns the filename component of a path (last segment after /). */
export function filenameTail(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
