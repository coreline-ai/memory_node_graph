import type { KnowledgeEdge, KnowledgeNode, RelationLayer } from "../../graph-data";
import type { GraphSnapshot } from "./model";

const STRUCTURAL_TYPES = new Set(["documents", "plans", "contains"]);

export const relationLayerFor = (edge: KnowledgeEdge): RelationLayer =>
  edge.layer
  ?? (edge.origin === "codex"
    ? "inferred"
    : edge.origin === "display"
      ? "display"
      : STRUCTURAL_TYPES.has(edge.type)
        ? "structural"
        : "explicit");

export const relationWeight = (edge: KnowledgeEdge) => {
  const layer = relationLayerFor(edge);
  if (layer === "display") return 0;
  if (layer === "structural") return 0.22;
  if (layer === "inferred") return Math.max(0.1, edge.confidence * 0.82);
  return Math.max(0.2, edge.confidence);
};

const edgeKey = (edge: KnowledgeEdge) => `${edge.source}|${edge.target}|${edge.type}`;

export function analyzeGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  const sortedNodes = [...snapshot.nodes].sort((left, right) => left.id.localeCompare(right.id));
  const nodeIds = new Set(sortedNodes.map((node) => node.id));
  const factualEdges = snapshot.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && relationWeight(edge) > 0)
    .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
  const adjacency = new Map<string, Map<string, number>>(
    sortedNodes.map((node) => [node.id, new Map()]),
  );
  const outgoing = new Map<string, Array<{ target: string; weight: number }>>(
    sortedNodes.map((node) => [node.id, []]),
  );
  for (const edge of factualEdges) {
    const weight = relationWeight(edge);
    adjacency.get(edge.source)!.set(
      edge.target,
      (adjacency.get(edge.source)!.get(edge.target) ?? 0) + weight,
    );
    adjacency.get(edge.target)!.set(
      edge.source,
      (adjacency.get(edge.target)!.get(edge.source) ?? 0) + weight,
    );
    outgoing.get(edge.source)!.push({ target: edge.target, weight });
  }

  const labels = new Map(sortedNodes.map((node) => [node.id, node.id]));
  for (let iteration = 0; iteration < 18; iteration += 1) {
    let changed = 0;
    for (const node of sortedNodes) {
      const scores = new Map<string, number>();
      for (const [neighbor, weight] of adjacency.get(node.id) ?? []) {
        const label = labels.get(neighbor)!;
        scores.set(label, (scores.get(label) ?? 0) + weight);
      }
      if (!scores.size) continue;
      const next = [...scores.entries()].sort((left, right) =>
        right[1] - left[1] || left[0].localeCompare(right[0]))[0][0];
      if (next !== labels.get(node.id)) {
        labels.set(node.id, next);
        changed += 1;
      }
    }
    if (!changed) break;
  }

  const damping = 0.85;
  const nodeCount = Math.max(1, sortedNodes.length);
  let ranks = new Map(sortedNodes.map((node) => [node.id, 1 / nodeCount]));
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const next = new Map(sortedNodes.map((node) => [node.id, (1 - damping) / nodeCount]));
    let dangling = 0;
    for (const node of sortedNodes) {
      const links = outgoing.get(node.id) ?? [];
      const total = links.reduce((sum, item) => sum + item.weight, 0);
      if (total <= 0) {
        dangling += ranks.get(node.id) ?? 0;
        continue;
      }
      for (const link of links) {
        next.set(link.target, (next.get(link.target) ?? 0)
          + damping * (ranks.get(node.id) ?? 0) * (link.weight / total));
      }
    }
    const distributed = damping * dangling / nodeCount;
    for (const node of sortedNodes) next.set(node.id, (next.get(node.id) ?? 0) + distributed);
    ranks = next;
  }
  const maximumRank = Math.max(...ranks.values(), 1 / nodeCount);

  const rawCommunities = new Map<string, KnowledgeNode[]>();
  for (const node of sortedNodes) {
    const label = labels.get(node.id)!;
    const members = rawCommunities.get(label) ?? [];
    members.push(node);
    rawCommunities.set(label, members);
  }
  const communityRows = [...rawCommunities.entries()].map(([rawId, members]) => {
    const representative = [...members].sort((left, right) =>
      (ranks.get(right.id) ?? 0) - (ranks.get(left.id) ?? 0)
      || (adjacency.get(right.id)?.size ?? 0) - (adjacency.get(left.id)?.size ?? 0)
      || left.id.localeCompare(right.id))[0];
    return { rawId, members, representative };
  }).sort((left, right) =>
    right.members.length - left.members.length
    || left.representative.label.localeCompare(right.representative.label)
    || left.rawId.localeCompare(right.rawId));
  const communityIdByRaw = new Map(communityRows.map((row, index) => [
    row.rawId,
    `community-${String(index + 1).padStart(2, "0")}`,
  ]));

  const enrichedNodes = sortedNodes.map((node) => {
    const neighborCommunities = new Set(
      [...(adjacency.get(node.id)?.keys() ?? [])].map((neighbor) => labels.get(neighbor)),
    );
    return {
      ...node,
      metrics: {
        communityId: communityIdByRaw.get(labels.get(node.id)!)!,
        centrality: Number(((ranks.get(node.id) ?? 0) / maximumRank).toFixed(6)),
        degree: adjacency.get(node.id)?.size ?? 0,
        bridge: neighborCommunities.size > 1,
      },
    };
  });

  let componentCount = 0;
  const visited = new Set<string>();
  for (const node of sortedNodes) {
    if (visited.has(node.id)) continue;
    componentCount += 1;
    const queue = [node.id];
    visited.add(node.id);
    for (let index = 0; index < queue.length; index += 1) {
      for (const neighbor of adjacency.get(queue[index])?.keys() ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  const inferredEdges = snapshot.edges.filter((edge) => relationLayerFor(edge) === "inferred");
  const nonStructuralEdges = snapshot.edges.filter((edge) => relationLayerFor(edge) !== "structural");
  const possibleEdges = sortedNodes.length > 1 ? sortedNodes.length * (sortedNodes.length - 1) : 1;
  const leafCount = sortedNodes.filter((node) => (adjacency.get(node.id)?.size ?? 0) <= 1).length;

  return {
    nodes: enrichedNodes,
    edges: [...snapshot.edges],
    meta: {
      ...snapshot.meta,
      analytics: {
        algorithm: "deterministic-weighted-label-propagation-pagerank-v1",
        communityCount: communityRows.length,
        componentCount,
        density: Number((factualEdges.length / possibleEdges).toFixed(6)),
        leafRatio: Number((leafCount / nodeCount).toFixed(6)),
        nonStructuralRatio: Number((nonStructuralEdges.length / Math.max(1, snapshot.edges.length)).toFixed(6)),
        inferredEvidenceCoverage: Number((
          inferredEdges.filter((edge) => edge.evidence?.length).length / Math.max(1, inferredEdges.length)
        ).toFixed(6)),
        communities: communityRows.map((row) => ({
          id: communityIdByRaw.get(row.rawId)!,
          label: row.representative.shortLabel,
          size: row.members.length,
          representativeNodeId: row.representative.id,
        })),
      },
    },
  };
}
