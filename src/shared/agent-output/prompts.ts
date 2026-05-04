/**
 * Compact prompt blocks rendered from output contracts.
 * Keeps file paths, formats, and final-response rules out of handwritten prompts.
 */

import { stageCompleteFinalResponseContract, type FinalResponseContract, type ResolvedFileOutputContract } from "./contracts.js";

/** Render hard file-output requirements for a stage prompt. */
export function outputContractPromptBlock(contracts: readonly ResolvedFileOutputContract[]): string {
  if (contracts.length === 0) return "";
  return `OUTPUT CONTRACTS -- HARD REQUIREMENTS\n${contracts.map(renderContract).join("\n\n")}\n\nBefore final response: write every required file above, then self-check that each path exists and matches its format. Do not put final response JSON inside artifact files.`;
}

/** Render a strict final-response requirement from the declared contract. */
export function finalResponsePromptBlock(
  contract: FinalResponseContract = stageCompleteFinalResponseContract,
): string {
  return `FINAL RESPONSE CONTRACT -- HARD REQUIREMENT\nContract: ${contract.id}\nPurpose: ${contract.description}\nYour final assistant response must be exactly this bare JSON object and nothing else:\n${contract.example}`;
}

/** Render a final-line JSON marker contract for natural-language chat turns. */
export function finalLineResponsePromptBlock(contract: FinalResponseContract): string {
  return `FINAL RESPONSE CONTRACT -- HARD REQUIREMENT\nContract: ${contract.id}\nPurpose: ${contract.description}\nAfter your reply, append exactly one JSON object on its own final line:\n${contract.example}\nThe marker must be valid JSON on its own final line. Nothing after it.`;
}

function renderContract(contract: ResolvedFileOutputContract): string {
  const validation = contract.kind === "text"
    ? "non-empty text file"
    : "strict JSON object; unknown keys are invalid; no markdown fences; no trailing prose";

  return [
    `- ${contract.prompt.name} (${contract.id})`,
    `  path: ${contract.path}`,
    `  kind: ${contract.kind}`,
    `  policy: ${contract.policy}`,
    `  validation: ${validation}`,
    contract.prompt.instructions ? `  instructions: ${contract.prompt.instructions}` : null,
    contract.prompt.skeleton ? `  copyable skeleton:\n${indent(contract.prompt.skeleton, "    ")}` : null,
  ].filter(Boolean).join("\n");
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}
