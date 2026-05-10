/** Public image serving for PR review visual artifacts. */

import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { isInsideArtifacts, reviewAssetPath } from "../../pipelines/pr-review/assets.js";
import { notFound, UUID_PATTERN } from "../http.js";

const PNG_EXT_RE = /\.png$/i;

export function registerReviewAssetRoutes(app: Hono): void {
  app.get("/review-assets/:taskId/:filename", async (c) => {
    const taskId = c.req.param("taskId");
    const filename = c.req.param("filename");
    if (!UUID_PATTERN.test(taskId) || !PNG_EXT_RE.test(filename)) return notFound(c);

    const filePath = reviewAssetPath(taskId, filename);
    if (!filePath || !isInsideArtifacts(filePath)) return notFound(c);

    try {
      return new Response(await readFile(filePath), {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
        },
      });
    } catch {
      return notFound(c);
    }
  });
}
