/**
 * Reads and validates review.json through the PR review output contract.
 * Missing files, malformed JSON, and schema failures return null for uniform UI handling.
 */

import { stat } from "node:fs/promises";
import { createLogger } from "../../../shared/runtime/logger.js";
import { validateFileOutput } from "../../../shared/agent-output/validation.js";
import type { ResolvedFileOutputContract } from "../../../shared/agent-output/contracts.js";
import { prReviewOutputs } from "../output-contracts.js";
import type { PrReviewArtifact } from "../../../shared/contracts/pr-review.js";

const log = createLogger("pr-review-read");

export interface ReadReviewArtifactResult {
  artifact: PrReviewArtifact;
  createdAt: Date;
}

/** All-or-nothing: any failure returns null, with the cause logged. */
export async function readReviewArtifact(
  input: string | ResolvedFileOutputContract<PrReviewArtifact>,
): Promise<ReadReviewArtifactResult | null> {
  const contract = typeof input === "string"
    ? { ...prReviewOutputs.review.resolve("", undefined), path: input }
    : input;

  const result = await validateFileOutput(contract);
  if (!result.valid) {
    log.warn(`review.json failed validation at ${contract.path}: ${result.reason}`);
    return null;
  }
  if (!result.data) {
    log.warn(`review.json validation produced no data at ${contract.path}`);
    return null;
  }

  try {
    const info = await stat(contract.path);
    return { artifact: result.data, createdAt: info.mtime };
  } catch (err) {
    log.warn(`review.json stat failed at ${contract.path}`, err);
    return null;
  }
}
