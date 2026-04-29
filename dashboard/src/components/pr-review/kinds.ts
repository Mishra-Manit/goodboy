/** Single source of truth for annotation kind presentation. */

import type { PrReviewAnnotationKind } from "@dashboard/shared";

interface KindStyle {
  label: string;
  /** Tailwind text colour token for chip + dot. */
  text: string;
  /** Background tint for kind chip pill. */
  bg: string;
  /** Tailwind border colour for the comment card left edge. */
  border: string;
}

const STYLES: Record<PrReviewAnnotationKind, KindStyle> = {
  concern: {
    label: "concern",
    text: "text-fail",
    bg: "bg-fail-dim",
    border: "border-l-fail",
  },
  goodboy_fix: {
    label: "goodboy fix",
    text: "text-accent",
    bg: "bg-accent-dim",
    border: "border-l-accent",
  },
  user_change: {
    label: "user change",
    text: "text-text-secondary",
    bg: "bg-white/5",
    border: "border-l-text-ghost",
  },
  note: {
    label: "note",
    text: "text-info",
    bg: "bg-info-dim",
    border: "border-l-info",
  },
};

export function kindStyle(kind: PrReviewAnnotationKind): KindStyle {
  return STYLES[kind];
}
