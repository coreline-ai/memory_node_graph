export function syncRenderedNodePositions(
  basePositions: Float32Array,
  renderedPositions: Float32Array,
) {
  if (basePositions.length !== renderedPositions.length) {
    throw new RangeError("Graph position buffers must have equal lengths.");
  }
  renderedPositions.set(basePositions);
}

export function renderedNodePosition(
  renderedPositions: Float32Array,
  nodeIndex: number,
): [number, number, number] | null {
  const offset = nodeIndex * 3;
  if (
    !Number.isInteger(nodeIndex) ||
    nodeIndex < 0 ||
    offset + 2 >= renderedPositions.length
  ) {
    return null;
  }
  return [
    renderedPositions[offset],
    renderedPositions[offset + 1],
    renderedPositions[offset + 2],
  ];
}
