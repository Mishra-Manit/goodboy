/**
 * Reads and validates review.json. Missing files, malformed JSON, and schema
 * failures all return null so callers can show a uniform unavailable state.
 */

import { readFile, stat } from "node:fs/promises";
import { createLogger } from "../../../shared/runtime/logger.js";
import { prReviewArtifactSchema, type PrReviewArtifact } from "../../../shared/contracts/pr-review.js";

const log = createLogger("pr-review-read");

export interface ReadReviewArtifactResult {
  artifact: PrReviewArtifact;
  createdAt: Date;
}

// --- Public API ---

/** All-or-nothing: any failure returns null, with the cause logged. */
export async function readReviewArtifact(path: string): Promise<ReadReviewArtifactResult | null> {
  let raw: string;
  let createdAt: Date;
  try {
    raw = await readFile(path, "utf8");
    const info = await stat(path);
    createdAt = info.mtime;
  } catch (err) {
    log.warn(`review.json not readable at ${path}`, err);
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    log.warn(`review.json malformed at ${path}`, err);
    return null;
  }

  const parsed = prReviewArtifactSchema.safeParse(json);
  if (!parsed.success) {
    log.warn(`review.json failed schema validation at ${path}: ${parsed.error.message}`);
    return null;
  }

  return { artifact: parsed.data, createdAt };
}
