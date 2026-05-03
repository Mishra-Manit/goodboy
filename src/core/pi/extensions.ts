/**
 * Extension path bundles for spawned pi sessions.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PiExtensionCapability {
  extensions: string[];
  envOverrides: Record<string, string>;
}

/** Capability bundle for review sessions that can mutate feedback memory. */
export function codeReviewerFeedbackCapability(): PiExtensionCapability {
  return {
    extensions: [path.resolve(__dirname, "../../../src/extensions/code-reviewer-feedback.ts")],
    envOverrides: {},
  };
}
