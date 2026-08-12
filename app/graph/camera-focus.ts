import type { GraphViewMode } from "./layouts";

type LayoutCameraFocusInput = {
  previousView: GraphViewMode;
  nextView: GraphViewMode;
  previousCenterId?: string | null;
  nextCenterId?: string | null;
  animateTransition: boolean;
};

/**
 * Orbit layout changes move the newly selected node to the world origin.
 * Recenter the camera as well so the node does not move outside the viewport
 * when the user previously panned or rotated the graph.
 */
export function shouldRecenterLayoutCamera({
  previousView,
  nextView,
  previousCenterId,
  nextCenterId,
  animateTransition,
}: LayoutCameraFocusInput) {
  return (
    !animateTransition ||
    previousView !== nextView ||
    (nextView === "orbit" && previousCenterId !== nextCenterId)
  );
}

export function selectionCameraDistance(
  currentDistance: number,
  minDistance: number,
  maxDistance: number,
) {
  const safeMinimum = Number.isFinite(minDistance) ? Math.max(0, minDistance) : 0;
  const safeMaximum = Number.isFinite(maxDistance)
    ? Math.max(safeMinimum, maxDistance)
    : safeMinimum;
  const safeCurrent = Number.isFinite(currentDistance)
    ? currentDistance
    : safeMinimum;
  return Math.min(safeMaximum, Math.max(safeMinimum, safeCurrent));
}
