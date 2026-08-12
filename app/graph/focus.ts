import type { KnowledgeEdge } from "../graph-data";

export const EXPANDED_FOCUS_VISIBILITY = 0.62;

export type FocusDepth = "all" | "direct" | "expanded";

export type FocusVisibility = {
  nodeIds: Set<string> | null;
  edgeIds: Set<string> | null;
};

export type FocusState = {
  nodeIds: Set<string> | null;
  edgeIds: Set<string> | null;
  directNodeIds: Set<string> | null;
  expandedNodeIds: Set<string> | null;
  directEdgeIds: Set<string> | null;
  expandedEdgeIds: Set<string> | null;
};

export const graphEdgeId = (edge: KnowledgeEdge) =>
  `${edge.source}|${edge.target}|${edge.type}`;

export const emptyFocusState = (): FocusState => ({
  nodeIds: null,
  edgeIds: null,
  directNodeIds: null,
  expandedNodeIds: null,
  directEdgeIds: null,
  expandedEdgeIds: null,
});

export const emptyFocusVisibility = (): FocusVisibility => ({
  nodeIds: null,
  edgeIds: null,
});

export function buildSelectionFocus(
  edges: KnowledgeEdge[],
  selectedId: string,
): FocusState {
  const directNodeIds = new Set<string>();
  const expandedNodeIds = new Set<string>();
  const directEdgeIds = new Set<string>();
  const expandedEdgeIds = new Set<string>();

  edges.forEach((edge) => {
    if (edge.source !== selectedId && edge.target !== selectedId) return;
    const otherId = edge.source === selectedId ? edge.target : edge.source;
    if (otherId !== selectedId) directNodeIds.add(otherId);
    directEdgeIds.add(graphEdgeId(edge));
  });

  edges.forEach((edge) => {
    if (directEdgeIds.has(graphEdgeId(edge))) return;
    const sourceIsDirect = directNodeIds.has(edge.source);
    const targetIsDirect = directNodeIds.has(edge.target);
    if (!sourceIsDirect && !targetIsDirect) return;

    const otherId = sourceIsDirect ? edge.target : edge.source;
    if (otherId !== selectedId && !directNodeIds.has(otherId)) {
      expandedNodeIds.add(otherId);
    }
  });

  edges.forEach((edge) => {
    const id = graphEdgeId(edge);
    if (directEdgeIds.has(id)) return;
    const sourceInFocus =
      directNodeIds.has(edge.source) || expandedNodeIds.has(edge.source);
    const targetInFocus =
      directNodeIds.has(edge.target) || expandedNodeIds.has(edge.target);
    const touchesDirect =
      directNodeIds.has(edge.source) || directNodeIds.has(edge.target);
    if (sourceInFocus && targetInFocus && touchesDirect) {
      expandedEdgeIds.add(id);
    }
  });

  return {
    nodeIds: new Set([selectedId, ...directNodeIds, ...expandedNodeIds]),
    edgeIds: new Set([...directEdgeIds, ...expandedEdgeIds]),
    directNodeIds,
    expandedNodeIds,
    directEdgeIds,
    expandedEdgeIds,
  };
}

export function buildFilteredFocus(
  nodeIds: Set<string>,
  edgeIds: Set<string>,
): FocusState {
  return {
    nodeIds,
    edgeIds,
    directNodeIds: new Set(nodeIds),
    expandedNodeIds: new Set(),
    directEdgeIds: new Set(edgeIds),
    expandedEdgeIds: new Set(),
  };
}

export function selectionVisibilityForDepth(
  focus: FocusState,
  selectedId: string,
  depth: FocusDepth,
): FocusVisibility {
  if (depth === "all") return emptyFocusVisibility();
  if (depth === "direct") {
    return {
      nodeIds: new Set([selectedId, ...(focus.directNodeIds ?? [])]),
      edgeIds: new Set(focus.directEdgeIds ?? []),
    };
  }
  return {
    nodeIds: new Set(focus.nodeIds ?? [selectedId]),
    edgeIds: new Set(focus.edgeIds ?? []),
  };
}

const intersectNullableSets = (
  left: Set<string> | null,
  right: Set<string> | null,
) => {
  if (!left) return right ? new Set(right) : null;
  if (!right) return new Set(left);
  return new Set([...left].filter((value) => right.has(value)));
};

export function intersectFocusVisibility(
  left: FocusVisibility,
  right: FocusVisibility,
  alwaysVisibleNodeId?: string | null,
): FocusVisibility {
  const nodeIds = intersectNullableSets(left.nodeIds, right.nodeIds);
  const edgeIds = intersectNullableSets(left.edgeIds, right.edgeIds);
  if (nodeIds && alwaysVisibleNodeId) nodeIds.add(alwaysVisibleNodeId);
  return { nodeIds, edgeIds };
}

export function visibleGraphCounts(
  nodeIds: readonly string[],
  edges: KnowledgeEdge[],
  visibility: FocusVisibility,
) {
  const visibleNodeIds = visibility.nodeIds ?? new Set(nodeIds);
  let edgeCount = 0;
  edges.forEach((edge) => {
    if (
      (!visibility.edgeIds || visibility.edgeIds.has(graphEdgeId(edge))) &&
      visibleNodeIds.has(edge.source) &&
      visibleNodeIds.has(edge.target)
    ) {
      edgeCount += 1;
    }
  });
  return {
    nodes: visibility.nodeIds ? visibility.nodeIds.size : nodeIds.length,
    edges: edgeCount,
  };
}
