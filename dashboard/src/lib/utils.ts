/** Tiny view helpers. Formatters live in `format.ts`; this file stays minimal. */

import { clsx, type ClassValue } from "clsx";
export { shortId } from "@dashboard/shared";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
