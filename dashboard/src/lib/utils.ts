/** Tiny view helpers. Formatters live in `format.ts`; this file stays minimal. */

import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
