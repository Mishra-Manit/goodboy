/**
 * Small HTTP helpers shared by route modules.
 * Keeps route files focused on resource behavior instead of parsing boilerplate.
 */

import type { Context } from "hono";
import { z } from "zod";
import { safeArtifactPath } from "./helpers.js";

export const UUID_PATTERN = /^[0-9a-f-]{36}$/;

/** Standard dashboard 404 shape. */
export function notFound(c: Context) {
  return c.json({ error: "Not found" }, 404);
}

/** Parse optional enum query params without making invalid filters fatal. */
export function parseEnumQuery<T extends z.ZodEnum<[string, ...string[]]>>(
  schema: T,
  value: string | undefined,
): z.infer<T> | undefined {
  if (!value) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

/** Parse a positive integer limit query param. */
export function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/** Remove duplicate task-stage session rows for retry/revision stage variants. */
export function dedupeStageSessionRows<T extends { stage: string; variant: number | null }>(rows: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(`${row.stage}#${row.variant ?? "main"}`, row);
  return [...byKey.values()];
}

/** Validate task artifact id/name before resolving under artifactsDir. */
export function safeTaskArtifactPath(id: string, name: string): string | null {
  if (!UUID_PATTERN.test(id)) return null;
  return safeArtifactPath(id, name);
}
