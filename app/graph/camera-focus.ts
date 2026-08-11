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
