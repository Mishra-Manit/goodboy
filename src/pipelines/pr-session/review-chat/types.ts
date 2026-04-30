/** Shared types for the review-chat module. Pure data, no IO, no behavior. */

import type { PrReviewAnnotation } from "../../../shared/pr-review.js";

export interface ReviewChatContext {
  message: string;
  activeFile: string | null;
  annotation: PrReviewAnnotation | null;
}

export interface ReviewChatArtifacts {
  reviewPath: string;
  summaryPath: string;
  diffPath: string;
  updatedDiffPath: string;
  contextPath: string;
  updatedContextPath: string;
  reportsDir: string;
}

export interface ReviewChatResult {
  status: "complete" | "failed";
  changed: boolean;
}
