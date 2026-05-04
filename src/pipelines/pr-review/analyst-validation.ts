/** Dynamic output validation for the PR analyst stage. */

import { validateFileOutput } from "../../shared/agent-output/validation.js";
import type { StageValidation } from "../../core/stage.js";
import { HOLISTIC_REPORT_ID, prReviewOutputs } from "./output-contracts.js";

/** Validate the analyst's plan, summary, and one report per planned group plus holistic. */
export async function validatePrAnalystOutputs(artifactsDir: string): Promise<StageValidation> {
  const planContract = prReviewOutputs.reviewPlan.resolve(artifactsDir, undefined);
  const planResult = await validateFileOutput(planContract);
  if (!planResult.valid) return { valid: false, reason: planResult.reason };
  if (!planResult.data) return { valid: false, reason: "review-plan.json parsed without data" };

  const plan = planResult.data;
  const groupIds = plan.groups.map((group) => group.id);
  const uniqueGroupIds = new Set(groupIds);
  if (uniqueGroupIds.size !== groupIds.length) {
    return { valid: false, reason: "review-plan.json contains duplicate group ids" };
  }

  const emptyFocus = plan.groups.find((group) => group.focus.trim().length === 0);
  if (emptyFocus) return { valid: false, reason: `review-plan group ${emptyFocus.id} has empty focus` };

  const summaryResult = await validateFileOutput(prReviewOutputs.summary.resolve(artifactsDir, undefined));
  if (!summaryResult.valid) return { valid: false, reason: summaryResult.reason };

  for (const reportId of [...groupIds, HOLISTIC_REPORT_ID]) {
    const result = await validateFileOutput(prReviewOutputs.report.resolve(artifactsDir, { reportId }));
    if (!result.valid) return { valid: false, reason: result.reason };
    if (!result.data) return { valid: false, reason: `${reportId}.json parsed without data` };
    if (result.data.subagent_id !== reportId) {
      return { valid: false, reason: `${reportId}.json subagent_id mismatch: got ${result.data.subagent_id}` };
    }
  }

  return { valid: true };
}
