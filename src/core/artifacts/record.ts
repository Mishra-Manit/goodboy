/**
 * Materializes declared task artifacts to disk and upserts canonical DB content.
 * Used by the Goodboy artifact writer tool and idempotent backfills.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as queries from "../../db/repository.js";
import { canonicalJsonText, normalizeArtifactFilePath, sha256Text } from "../../shared/artifacts/index.js";
import { resolveDeclaredArtifactByFilePath } from "../../shared/agent-output/declared-task-artifacts.js";
import type { StageName, TaskKind } from "../../shared/domain/types.js";

export interface RecordedTaskArtifact {
  artifactId: string;
  filePath: string;
  absolutePath: string;
  sha256: string;
}

/** Record a declared DB-backed artifact and write the matching local file. */
export async function recordTaskArtifact(input: {
  taskId: string;
  taskKind: TaskKind;
  stage: StageName;
  taskStageId: string | null;
  producerSessionId: string | null;
  artifactsDir: string;
  filePath: string;
  contentText?: string;
  contentJson?: unknown;
}): Promise<RecordedTaskArtifact> {
  const filePath = normalizeArtifactFilePath(input.filePath);
  const contract = resolveDeclaredArtifactByFilePath({
    kind: input.taskKind,
    stage: input.stage,
    artifactsDir: input.artifactsDir,
    filePath,
  });
  if (!contract) throw new Error(`${filePath} is not a declared DB-backed artifact for ${input.taskKind}/${input.stage}`);

  const content = validateAndSerializeContent({
    contractKind: contract.kind,
    schema: contract.schema,
    contentText: input.contentText,
    contentJson: input.contentJson,
    filePath,
  });
  const sha256 = sha256Text(content.text);
  const absolutePath = path.join(input.artifactsDir, filePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content.text, "utf8");

  const artifact = await queries.upsertTaskArtifact({
    taskId: input.taskId,
    taskStageId: input.taskStageId,
    producerSessionId: input.producerSessionId,
    filePath,
    sha256,
    ...(content.kind === "text" ? { contentText: content.text } : { contentJson: content.json }),
  });

  return { artifactId: artifact.id, filePath, absolutePath, sha256 };
}

function validateAndSerializeContent(input: {
  contractKind: "text" | "json";
  schema: { safeParse: (value: unknown) => { success: boolean; error?: { message: string }; data?: unknown } } | undefined;
  contentText?: string;
  contentJson?: unknown;
  filePath: string;
}): { kind: "text"; text: string } | { kind: "json"; text: string; json: unknown } {
  const hasText = input.contentText !== undefined;
  const hasJson = input.contentJson !== undefined;
  if (hasText === hasJson) throw new Error(`${input.filePath} must provide exactly one content field`);

  if (input.contractKind === "text") {
    const text = input.contentText;
    if (text === undefined || text.trim().length === 0) throw new Error(`${input.filePath} requires non-empty contentText`);
    return { kind: "text", text };
  }

  if (!hasJson) throw new Error(`${input.filePath} requires contentJson`);
  const result = input.schema?.safeParse(input.contentJson);
  if (!result?.success) throw new Error(`${input.filePath} failed JSON schema validation: ${result?.error?.message ?? "missing schema"}`);
  return { kind: "json", text: canonicalJsonText(result.data), json: result.data };
}
