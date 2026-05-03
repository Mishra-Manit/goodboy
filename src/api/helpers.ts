/**
 * Small HTTP helpers shared by API route groups.
 * Keeps security-sensitive path validation out of the route body.
 */

import path from "node:path";
import { config } from "../shared/runtime/config.js";

const ARTIFACT_NAME_PATTERN = /^[\w][\w.-]*$/;

// --- Artifact Paths ---

/** True only for one safe artifact filename, never a path segment or hidden file. */
export function isSafeArtifactName(name: string): boolean {
  return ARTIFACT_NAME_PATTERN.test(name);
}

/** Resolve a task artifact path, rejecting traversal and path-like names. */
export function safeArtifactPath(id: string, name: string): string | null {
  if (!isSafeArtifactName(name)) return null;
  const base = path.resolve(config.artifactsDir);
  const full = path.resolve(path.join(base, id, name));
  return full.startsWith(`${base}${path.sep}`) ? full : null;
}
