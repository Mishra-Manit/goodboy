/** Shared PR impact variant constants used by pipeline and dashboard metadata. */

export const PR_IMPACT_VARIANT_COUNT = 3;

export interface PrImpactVariantFiles {
  diff: string;
  impact: string;
}

/** Root-level artifact filenames for one PR impact variant. */
export function prImpactVariantFiles(variant: number): PrImpactVariantFiles {
  return {
    diff: `pr.diff.v${variant}`,
    impact: `pr-impact.v${variant}.md`,
  };
}
