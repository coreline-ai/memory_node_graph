import type { NodeKind } from "../graph-data";

export type NodeSizeMode = "kind" | "degree" | "uniform";

export type NodeKindSizes = Record<NodeKind, number>;

type NodeSizeOptions = {
  minimum?: number;
  maximum?: number;
  uniform?: number;
};

export function percentile95(values: ArrayLike<number>) {
  const finite = Array.from(values, (value) =>
    Number.isFinite(value) ? Math.max(0, value) : 0,
  ).sort((left, right) => left - right);
  if (finite.length === 0) return 0;
  return finite[Math.max(0, Math.ceil(finite.length * 0.95) - 1)];
}

export function calculateNodeSizes(
  mode: NodeSizeMode,
  kinds: readonly NodeKind[],
  degrees: ArrayLike<number>,
  kindSizes: NodeKindSizes,
  options: NodeSizeOptions = {},
) {
  const minimum = Math.max(1, options.minimum ?? 8.5);
  const maximum = Math.max(minimum, options.maximum ?? 18);
  const uniform = Math.min(maximum, Math.max(minimum, options.uniform ?? 11.5));
  const result = new Float32Array(kinds.length);

  if (mode === "kind") {
    kinds.forEach((kind, index) => {
      const size = kindSizes[kind];
      result[index] = Math.min(
        maximum,
        Math.max(minimum, Number.isFinite(size) ? size : uniform),
      );
    });
    return result;
  }

  if (mode === "uniform") {
    result.fill(uniform);
    return result;
  }

  const p95 = percentile95(degrees);
  const scale = Math.log1p(Math.max(1, p95));
  for (let index = 0; index < result.length; index += 1) {
    const degree = Number.isFinite(degrees[index])
      ? Math.max(0, degrees[index])
      : 0;
    const normalized = Math.min(1, Math.log1p(degree) / scale);
    result[index] = minimum + (maximum - minimum) * normalized;
  }
  return result;
}

export function nodeSizeRange(sizes: ArrayLike<number>) {
  if (sizes.length === 0) return { minimum: 0, maximum: 0 };
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < sizes.length; index += 1) {
    minimum = Math.min(minimum, sizes[index]);
    maximum = Math.max(maximum, sizes[index]);
  }
  return { minimum, maximum };
}
