/** Filesystem and public URL helpers for PR review visual assets. */

import path from "node:path";
import { mkdir } from "node:fs/promises";
import { config, loadEnv } from "../../shared/runtime/config.js";
import { taskArtifactsDir } from "../../shared/artifact-paths/index.js";

export const PR_REVIEW_ASSETS_DIR = "assets";
export const PR_VISUAL_SUMMARY_FILENAME = "pr-visual-summary.png";
export const PR_VISUAL_MANIFEST_FILENAME = "manifest.json";

const SAFE_ASSET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/;

export function reviewAssetsDir(taskId: string): string {
  return path.join(taskArtifactsDir(taskId), PR_REVIEW_ASSETS_DIR);
}

export async function ensureReviewAssetsDir(taskId: string): Promise<string> {
  const dir = reviewAssetsDir(taskId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function reviewAssetPath(taskId: string, filename: string): string | null {
  if (!SAFE_ASSET_NAME_RE.test(filename)) return null;
  return path.join(reviewAssetsDir(taskId), filename);
}

export function publicReviewAssetUrl(taskId: string, filename: string): string {
  const env = loadEnv();
  const base = env.PUBLIC_ASSET_BASE_URL ?? `http://localhost:${env.PORT}`;
  return `${base.replace(/\/+$/, "")}/review-assets/${taskId}/${filename}`;
}

export function isInsideArtifacts(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const root = path.resolve(config.artifactsDir);
  return resolved.startsWith(`${root}${path.sep}`);
}
