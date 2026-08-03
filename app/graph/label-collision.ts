export type ScreenLabelCandidate = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  previouslyVisible?: boolean;
};

export type LabelViewport = {
  width: number;
  height: number;
  inset?: number;
};

type ScreenRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const overlaps = (left: ScreenRect, right: ScreenRect, gap: number) =>
  left.left < right.right + gap &&
  left.right + gap > right.left &&
  left.top < right.bottom + gap &&
  left.bottom + gap > right.top;

export function resolveLabelCollisions(
  candidates: ScreenLabelCandidate[],
  viewport: LabelViewport,
  gap = 5,
) {
  const inset = Math.max(0, viewport.inset ?? 6);
  const accepted: ScreenRect[] = [];
  const visibleIds = new Set<string>();

  [...candidates]
    .sort((left, right) => {
      const priorityDifference = right.priority - left.priority;
      if (priorityDifference) return priorityDifference;
      const stabilityDifference =
        Number(Boolean(right.previouslyVisible)) -
        Number(Boolean(left.previouslyVisible));
      return stabilityDifference || left.id.localeCompare(right.id);
    })
    .forEach((candidate) => {
      const width = Math.max(1, candidate.width);
      const height = Math.max(1, candidate.height);
      const rect = {
        left: candidate.x,
        top: candidate.y,
        right: candidate.x + width,
        bottom: candidate.y + height,
      };
      const outsideViewport =
        rect.left < inset ||
        rect.right > viewport.width - inset ||
        rect.top < inset ||
        rect.bottom > viewport.height - inset;
      if (outsideViewport || accepted.some((item) => overlaps(rect, item, gap))) {
        return;
      }
      accepted.push(rect);
      visibleIds.add(candidate.id);
    });

  return visibleIds;
}
