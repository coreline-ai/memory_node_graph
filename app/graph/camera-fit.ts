export type GraphPoint3 = readonly [number, number, number];

export type GraphBoundingSphere = {
  center: GraphPoint3;
  radius: number;
  count: number;
};

export type CameraFitResult = "home" | "fitted" | "empty";

export type CameraSafeFrame = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type PerspectiveBoundsFit = {
  center: GraphPoint3;
  targetOffset: GraphPoint3;
  distance: number;
  count: number;
};

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

type PerspectiveBoundsFitInput = {
  points: readonly GraphPoint3[];
  verticalFovDegrees: number;
  aspect: number;
  safeFrame: CameraSafeFrame;
  margin?: number;
  minDistance: number;
  maxDistance: number;
  nearDistance?: number;
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

function normalizedSafeBounds(frame: CameraSafeFrame, margin: number) {
  const width = Number.isFinite(frame.width) ? Math.max(1, frame.width) : 1;
  const height = Number.isFinite(frame.height) ? Math.max(1, frame.height) : 1;
  const left = clamp(Number.isFinite(frame.left) ? frame.left : 0, 0, width - 1);
  const right = clamp(Number.isFinite(frame.right) ? frame.right : width, left + 1, width);
  const top = clamp(Number.isFinite(frame.top) ? frame.top : 0, 0, height - 1);
  const bottom = clamp(Number.isFinite(frame.bottom) ? frame.bottom : height, top + 1, height);
  const safeMargin = clamp(Number.isFinite(margin) ? margin : 0.12, 0, 0.4);
  const centerX = (left + right) * 0.5;
  const centerY = (top + bottom) * 0.5;
  const halfWidth = Math.max(0.5, (right - left) * 0.5 * (1 - safeMargin));
  const halfHeight = Math.max(0.5, (bottom - top) * 0.5 * (1 - safeMargin));
  const innerLeft = centerX - halfWidth;
  const innerRight = centerX + halfWidth;
  const innerTop = centerY - halfHeight;
  const innerBottom = centerY + halfHeight;
  return {
    left: innerLeft / width * 2 - 1,
    right: innerRight / width * 2 - 1,
    top: 1 - innerTop / height * 2,
    bottom: 1 - innerBottom / height * 2,
  };
}

/**
 * Fits camera-aligned points into an asymmetric viewport safe frame.
 * Point axes are [camera-right, camera-up, camera-back]. The returned target
 * offset uses the same axes, allowing the graph to sit beside UI overlays
 * without changing the current viewing direction.
 */
export function calculatePerspectiveBoundsFit({
  points,
  verticalFovDegrees,
  aspect,
  safeFrame,
  margin = 0.12,
  minDistance,
  maxDistance,
  nearDistance = 1,
}: PerspectiveBoundsFitInput): PerspectiveBoundsFit | null {
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
  const safeVerticalFov = clamp(
    Number.isFinite(verticalFovDegrees) ? verticalFovDegrees : 50,
    1,
    179,
  );
  const tanVertical = Math.tan(safeVerticalFov * Math.PI / 360);
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const tanHorizontal = Math.max(1e-6, tanVertical * safeAspect);
  const bounds = normalizedSafeBounds(safeFrame, margin);
  const centerNdcX = (bounds.left + bounds.right) * 0.5;
  const centerNdcY = (bounds.bottom + bounds.top) * 0.5;
  const rightSpan = Math.max(1e-6, bounds.right - centerNdcX);
  const leftSpan = Math.max(1e-6, centerNdcX - bounds.left);
  const topSpan = Math.max(1e-6, bounds.top - centerNdcY);
  const bottomSpan = Math.max(1e-6, centerNdcY - bounds.bottom);
  const safeMinimum = Number.isFinite(minDistance) ? Math.max(0, minDistance) : 0;
  const safeMaximum = Number.isFinite(maxDistance)
    ? Math.max(safeMinimum, maxDistance)
    : safeMinimum;
  const safeNearDistance = Number.isFinite(nearDistance)
    ? Math.max(0, nearDistance)
    : 1;
  let requestedDistance = safeMinimum;

  safePoints.forEach(([x, y, z]) => {
    const deltaX = x - center[0];
    const deltaY = y - center[1];
    const deltaZ = z - center[2];
    requestedDistance = Math.max(
      requestedDistance,
      deltaZ + safeNearDistance,
      (deltaX / tanHorizontal + bounds.right * deltaZ) / rightSpan,
      (-deltaX / tanHorizontal - bounds.left * deltaZ) / leftSpan,
      (deltaY / tanVertical + bounds.top * deltaZ) / topSpan,
      (-deltaY / tanVertical - bounds.bottom * deltaZ) / bottomSpan,
    );
  });

  const distance = clamp(requestedDistance, safeMinimum, safeMaximum);
  const targetOffsetX = -centerNdcX * distance * tanHorizontal;
  const targetOffsetY = -centerNdcY * distance * tanVertical;
  return {
    center,
    targetOffset: [
      Math.abs(targetOffsetX) < 1e-12 ? 0 : targetOffsetX,
      Math.abs(targetOffsetY) < 1e-12 ? 0 : targetOffsetY,
      0,
    ],
    distance,
    count: safePoints.length,
  };
}
