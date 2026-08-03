import type { KnowledgeEdge } from "../graph-data";

export const EXPANDED_FOCUS_VISIBILITY = 0.62;

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
    directNodeIds.add(edge.source === selectedId ? edge.target : edge.source);
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
