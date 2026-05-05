/**
 * PR review display artifact contract. The pr_display stage writes review.json
 * matching this schema; the API and dashboard consume it without DB persistence.
 */

import { z } from "zod";
import { PR_SESSION_MODES } from "../domain/types.js";

// --- Enums ---

export const PR_REVIEW_ANNOTATION_KINDS = ["goodboy_fix", "concern", "note"] as const;

export type PrReviewAnnotationKind = (typeof PR_REVIEW_ANNOTATION_KINDS)[number];

// --- Schemas ---

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

const prReviewFileSchema = z.object({
  path: z.string().min(1),
  narrative: z.string().min(1).max(300),
}).strict();

export const prReviewAnnotationSchema = z.object({
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  kind: z.enum(PR_REVIEW_ANNOTATION_KINDS),
  title: z.string().min(1).max(140),
  body: z.string().min(1).max(1500),
}).strict();

export const prReviewChapterSchema = z.object({
  id: slugSchema,
  title: z.string().min(1).max(120),
  files: z.array(prReviewFileSchema).min(1),
  narrative: z.string().min(1).max(400),
  annotations: z.array(prReviewAnnotationSchema),
}).strict();

export const prReviewArtifactSchema = z.object({
  prTitle: z.string().min(1).max(200),
  headSha: z.string().min(7).max(64),
  summary: z.string().min(1).max(2000),
  chapters: z.array(prReviewChapterSchema).min(1),
}).strict().superRefine((value, ctx) => {
  const seenChapterIds = new Set<string>();
  for (const chapter of value.chapters) {
    if (seenChapterIds.has(chapter.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate chapter id: ${chapter.id}` });
    }
    seenChapterIds.add(chapter.id);

    const filePathSet = new Set(chapter.files.map((file) => file.path));
    for (const annotation of chapter.annotations) {
      if (!filePathSet.has(annotation.filePath)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `annotation filePath '${annotation.filePath}' not in chapter '${chapter.id}' files`,
        });
      }
    }
  }
});

// --- Types ---

export type PrReviewFile = z.infer<typeof prReviewFileSchema>;
export type PrReviewAnnotation = z.infer<typeof prReviewAnnotationSchema>;
export type PrReviewChapter = z.infer<typeof prReviewChapterSchema>;
export type PrReviewArtifact = z.infer<typeof prReviewArtifactSchema>;

// --- API DTO ---

export const prReviewPageDtoSchema = z.object({
  session: z.object({
    id: z.string(),
    repo: z.string(),
    prNumber: z.number().int().positive().nullable(),
    prUrl: z.string().nullable(),
    branch: z.string().nullable(),
    mode: z.enum(PR_SESSION_MODES),
  }),
  run: z.intersection(
    prReviewArtifactSchema,
    z.object({
      diffPatch: z.string(),
      createdAt: z.string(),
    }),
  ).nullable(),
});

export type PrReviewPageDto = z.infer<typeof prReviewPageDtoSchema>;

// --- Review chat DTOs ---

export const reviewChatTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const reviewChatAnnotationPartSchema = z.object({
  type: z.literal("annotation"),
  annotation: prReviewAnnotationSchema,
});

export const reviewChatPartSchema = z.union([
  reviewChatTextPartSchema,
  reviewChatAnnotationPartSchema,
]);

export const reviewChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(reviewChatPartSchema).min(1),
  createdAt: z.string(),
});

export const reviewChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  activeFile: z.string().min(1).nullable(),
  annotation: prReviewAnnotationSchema.nullable(),
});

export const reviewChatResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  messages: z.array(reviewChatMessageSchema),
});

export const reviewChatPostResponseSchema = z.object({
  ok: z.literal(true),
  changed: z.boolean(),
  messages: z.array(reviewChatMessageSchema),
});

export type ReviewChatPart = z.infer<typeof reviewChatPartSchema>;
export type ReviewChatMessage = z.infer<typeof reviewChatMessageSchema>;
export type ReviewChatRequest = z.infer<typeof reviewChatRequestSchema>;
export type ReviewChatResponse = z.infer<typeof reviewChatResponseSchema>;
export type ReviewChatPostResponse = z.infer<typeof reviewChatPostResponseSchema>;
