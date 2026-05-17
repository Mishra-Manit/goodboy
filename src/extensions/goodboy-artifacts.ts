/** pi extension exposing the controlled Goodboy artifact writer tool. */

import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { recordTaskArtifact } from "../core/artifacts/record.js";
import { TASK_KINDS, STAGE_NAMES, type StageName, type TaskKind } from "../shared/domain/types.js";
import { createLogger } from "../shared/runtime/logger.js";

const log = createLogger("artifact-tool");

const paramsSchema = Type.Object({
  filePath: Type.String(),
  contentText: Type.Optional(Type.String()),
  contentJson: Type.Optional(Type.Unknown()),
});

type Params = Static<typeof paramsSchema>;

/** Register the DB-backed task artifact writer tool. */
export default function goodboyArtifactsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "goodboy_artifact",
    label: "Goodboy Artifact",
    description: "Record a declared Goodboy artifact and materialize it to the task artifacts folder.",
    promptSnippet: "Use goodboy_artifact for every declared DB-backed output artifact instead of write/edit/bash redirection.",
    promptGuidelines: [
      "Use this tool only for declared final artifacts requested by the current stage.",
      "Do not use write/edit/bash redirection to create plan.md, implementation-summary.md, review.md, or answer.md.",
      "Pass contentText for markdown/plain text outputs and contentJson for JSON outputs.",
    ],
    parameters: paramsSchema,
    async execute(_toolCallId, params: Params) {
      const env = readArtifactEnv();
      const result = await recordTaskArtifact({
        ...env,
        filePath: params.filePath,
        contentText: params.contentText,
        contentJson: params.contentJson,
      });
      log.info(`Recorded artifact ${result.filePath} for task ${env.taskId}`);
      return {
        content: [{ type: "text", text: `Recorded ${result.filePath} at ${result.absolutePath}` }],
        details: result,
      };
    },
  });
}

function readArtifactEnv(): {
  taskId: string;
  taskKind: TaskKind;
  stage: StageName;
  taskStageId: string | null;
  producerSessionId: null;
  artifactsDir: string;
} {
  const taskId = process.env.GOODBOY_TASK_ID;
  const taskKind = parseTaskKind(process.env.GOODBOY_TASK_KIND);
  const stage = parseStageName(process.env.GOODBOY_STAGE);
  const taskStageId = process.env.GOODBOY_TASK_STAGE_ID || null;
  const artifactsDir = process.env.GOODBOY_ARTIFACTS_DIR;

  if (!taskId || !taskKind || !stage || !artifactsDir) {
    throw new Error("goodboy_artifact missing or invalid GOODBOY_* environment");
  }

  return { taskId, taskKind, stage, taskStageId, producerSessionId: null, artifactsDir };
}

function parseTaskKind(value: string | undefined): TaskKind | null {
  return value && (TASK_KINDS as readonly string[]).includes(value) ? value as TaskKind : null;
}

function parseStageName(value: string | undefined): StageName | null {
  return value && (STAGE_NAMES as readonly string[]).includes(value) ? value as StageName : null;
}
