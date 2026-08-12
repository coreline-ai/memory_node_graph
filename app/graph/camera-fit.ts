export type GraphPoint3 = readonly [number, number, number];

export type GraphBoundingSphere = {
  center: GraphPoint3;
  radius: number;
  count: number;
};

export type CameraFitResult = "moved" | "empty";

const finitePoint = (point: GraphPoint3) =>
  Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);

export function calculateGraphBoundingSphere(
  points: readonly GraphPoint3[],
): GraphBoundingSphere | null {
  const safePoints = points.filter(finitePoint);
  if (safePoints.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  safePoints.forEach(([x, y, z]) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  });

  const center: GraphPoint3 = [
    (minX + maxX) * 0.5,
    (minY + maxY) * 0.5,
    (minZ + maxZ) * 0.5,
  ];
  let radius = 0;
  safePoints.forEach(([x, y, z]) => {
    radius = Math.max(
      radius,
      Math.hypot(x - center[0], y - center[1], z - center[2]),
    );
  });

  return { center, radius, count: safePoints.length };
}

type PerspectiveFitDistanceInput = {
  radius: number;
  verticalFovDegrees: number;
  aspect: number;
  margin?: number;
  minimumRadius?: number;
  minDistance: number;
  maxDistance: number;
};

export function perspectiveFitDistance({
  radius,
  verticalFovDegrees,
  aspect,
  margin = 0.15,
  minimumRadius = 0,
  minDistance,
  maxDistance,
}: PerspectiveFitDistanceInput) {
  const safeVerticalFov = Math.min(179, Math.max(1, verticalFovDegrees));
  const verticalHalfFov = safeVerticalFov * Math.PI / 360;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * safeAspect);
  const effectiveHalfFov = Math.max(
    Math.PI / 360,
    Math.min(verticalHalfFov, horizontalHalfFov),
  );
  const safeMargin = Math.min(1, Math.max(0, Number.isFinite(margin) ? margin : 0.15));
  const safeRadius = Math.max(
    0,
    Number.isFinite(radius) ? radius : 0,
    Number.isFinite(minimumRadius) ? minimumRadius : 0,
  );
  const requestedDistance = safeRadius * (1 + safeMargin) / Math.sin(effectiveHalfFov);
  const safeMinimum = Number.isFinite(minDistance) ? Math.max(0, minDistance) : 0;
  const safeMaximum = Number.isFinite(maxDistance)
    ? Math.max(safeMinimum, maxDistance)
    : safeMinimum;
  return Math.min(safeMaximum, Math.max(safeMinimum, requestedDistance));
}
