import type { NodeKind } from "../graph-data";

export type LabelLod = "overview" | "explore" | "detail";
export type LabelDensity = "low" | "medium" | "high";
export type LabelFocusTier =
  | "selected"
  | "direct"
  | "expanded"
  | "ambient";

export type LabelCandidate = {
  id: string;
  kind: NodeKind;
  degree: number;
  focusTier: LabelFocusTier;
};

const KIND_IMPORTANCE: Record<NodeKind, number> = {
  thesis: 700,
  system: 440,
  risk: 380,
  concept: 330,
  practice: 280,
  tool: 260,
};

const FOCUS_IMPORTANCE: Record<LabelFocusTier, number> = {
  selected: 4_000,
  direct: 3_000,
  expanded: 2_000,
  ambient: 0,
};

const DESKTOP_LIMITS: Record<LabelDensity, Record<LabelLod, number>> = {
  low: { overview: 3, explore: 6, detail: 10 },
  medium: { overview: 5, explore: 10, detail: 16 },
  high: { overview: 15, explore: 30, detail: 48 },
};

const COMPACT_LIMITS: Record<LabelDensity, Record<LabelLod, number>> = {
  low: { overview: 2, explore: 4, detail: 6 },
  medium: { overview: 4, explore: 7, detail: 10 },
  high: { overview: 8, explore: 14, detail: 20 },
};

const SELECTION_BONUS: Record<LabelLod, number> = {
  overview: 3,
  explore: 3,
  detail: 0,
};

export function resolveLabelLod(
  cameraDistance: number,
  graphRadius: number,
): LabelLod {
  const safeRadius = Math.max(1, graphRadius);
  const distanceRatio = Math.max(0, cameraDistance) / safeRadius;
  if (distanceRatio >= 1.65) return "overview";
  if (distanceRatio >= 0.95) return "explore";
  return "detail";
}

export function labelLimit(
  lod: LabelLod,
  compact: boolean,
  hasSelection: boolean,
  density: LabelDensity = "medium",
) {
  const baseLimit = (compact ? COMPACT_LIMITS : DESKTOP_LIMITS)[density][lod];
  if (!hasSelection) return baseLimit;
  const compactBonus = compact ? Math.min(2, SELECTION_BONUS[lod]) : SELECTION_BONUS[lod];
  return baseLimit + compactBonus;
}

export function scoreLabelCandidate(candidate: LabelCandidate) {
  const degree = Number.isFinite(candidate.degree)
    ? Math.max(0, candidate.degree)
    : 0;
  return (
    FOCUS_IMPORTANCE[candidate.focusTier] +
    KIND_IMPORTANCE[candidate.kind] +
    degree * 18
  );
}

export function selectLabelIds(
  candidates: LabelCandidate[],
  lod: LabelLod,
  compact: boolean,
  hasSelection: boolean,
  density: LabelDensity = "medium",
) {
  const limit = labelLimit(lod, compact, hasSelection, density);
  return new Set(
    [...candidates]
      .sort((left, right) => {
        const scoreDifference =
          scoreLabelCandidate(right) - scoreLabelCandidate(left);
        return scoreDifference || left.id.localeCompare(right.id);
      })
      .slice(0, limit)
      .map((candidate) => candidate.id),
  );
}
