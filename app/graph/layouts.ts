import type { Domain, KnowledgeEdge, KnowledgeNode } from "../graph-data";

export type GraphViewMode = "constellation" | "nebula" | "orbit";
export type PositionTuple = [number, number, number];

export type LayoutResult = {
  positions: PositionTuple[];
  centerId?: string;
  oneHop: Set<string>;
  twoHop: Set<string>;
  clusterCenters: Map<Domain, PositionTuple>;
  orbitRadii?: [number, number];
};

const DOMAIN_ORDER: Domain[] = [
  "reasoning",
  "agents",
  "memory",
  "safety",
  "product",
  "infrastructure",
];

const emptyResult = (positions: PositionTuple[]): LayoutResult => ({
  positions,
  oneHop: new Set(),
  twoHop: new Set(),
  clusterCenters: new Map(),
});

const hash = (value: string) => {
  let current = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    current ^= value.charCodeAt(index);
    current = Math.imul(current, 16777619);
  }
  return current >>> 0;
};

const randomFrom = (value: string, salt: number) => {
  let seed = hash(`${value}:${salt}`) || 1;
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967295;
};

export function constellationLayout(positions: PositionTuple[]) {
  return emptyResult(positions.map((position) => [...position] as PositionTuple));
}

export function nebulaLayout(
  nodes: KnowledgeNode[],
  graphRadius: number,
): LayoutResult {
  const clusterCenters = new Map<Domain, PositionTuple>();
  const domainCounts = new Map<Domain, number>();

  DOMAIN_ORDER.forEach((domain, index) => {
    const angle = (index / DOMAIN_ORDER.length) * Math.PI * 2 - Math.PI / 2;
    const lane = index % 2 === 0 ? 0.86 : 1.08;
    clusterCenters.set(domain, [
      Math.cos(angle) * graphRadius * lane,
      Math.sin(angle) * graphRadius * 0.62 * lane,
      Math.sin(angle * 1.7) * graphRadius * 0.34,
    ]);
    domainCounts.set(domain, 0);
  });

  const positions = nodes.map((node): PositionTuple => {
    const center = clusterCenters.get(node.domain) ?? [0, 0, 0];
    const ordinal = domainCounts.get(node.domain) ?? 0;
    domainCounts.set(node.domain, ordinal + 1);
    const angle = ordinal * 2.399963 + randomFrom(node.id, 1) * 0.9;
    const radial = graphRadius *
      (0.12 + Math.sqrt(ordinal + 1) * 0.035 + randomFrom(node.id, 2) * 0.08);
    const depth = (randomFrom(node.id, 3) - 0.5) * graphRadius * 0.48;
    return [
      center[0] + Math.cos(angle) * radial,
      center[1] + Math.sin(angle) * radial * 0.72,
      center[2] + depth,
    ];
  });

  return {
    positions,
    oneHop: new Set(),
    twoHop: new Set(),
    clusterCenters,
  };
}

const adjacencyFor = (nodes: KnowledgeNode[], edges: KnowledgeEdge[]) => {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  edges.forEach((edge) => {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  });
  return adjacency;
};

export function mostConnectedNodeId(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
) {
  const adjacency = adjacencyFor(nodes, edges);
  return [...nodes]
    .sort(
      (a, b) =>
        (adjacency.get(b.id)?.size ?? 0) - (adjacency.get(a.id)?.size ?? 0) ||
        a.id.localeCompare(b.id),
    )[0]?.id;
}

export function orbitLayout(
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  graphRadius: number,
  requestedCenterId?: string | null,
): LayoutResult {
  const adjacency = adjacencyFor(nodes, edges);
  const centerId =
    (requestedCenterId && adjacency.has(requestedCenterId)
      ? requestedCenterId
      : mostConnectedNodeId(nodes, edges)) ?? nodes[0]?.id;
  const oneHop = new Set(adjacency.get(centerId ?? "") ?? []);
  const twoHop = new Set<string>();
  oneHop.forEach((id) =>
    adjacency.get(id)?.forEach((candidate) => {
      if (candidate !== centerId && !oneHop.has(candidate)) twoHop.add(candidate);
    }),
  );

  const first = [...oneHop].sort();
  const second = [...twoHop].sort();
  const rest = nodes
    .map((node) => node.id)
    .filter((id) => id !== centerId && !oneHop.has(id) && !twoHop.has(id))
    .sort();
  const innerRadius = graphRadius * 0.72;
  const outerRadius = graphRadius * 1.28;
  const positionsById = new Map<string, PositionTuple>();
  if (centerId) positionsById.set(centerId, [0, 0, 0]);

  const placeRing = (ids: string[], radius: number, depth: number) => {
    ids.forEach((id, index) => {
      const angle = (index / Math.max(1, ids.length)) * Math.PI * 2 - Math.PI / 2;
      positionsById.set(id, [
        Math.cos(angle) * radius,
        Math.sin(angle) * radius * 0.48,
        Math.sin(angle * 2) * depth,
      ]);
    });
  };
  placeRing(first, innerRadius, graphRadius * 0.12);
  placeRing(second, outerRadius, graphRadius * 0.22);

  rest.forEach((id, index) => {
    const angle = (index / Math.max(1, rest.length)) * Math.PI * 2;
    const radius = graphRadius * (1.75 + randomFrom(id, 4) * 0.55);
    positionsById.set(id, [
      Math.cos(angle) * radius,
      Math.sin(angle) * radius * 0.66,
      (randomFrom(id, 5) - 0.5) * graphRadius * 1.4,
    ]);
  });

  return {
    positions: nodes.map((node) => positionsById.get(node.id) ?? [0, 0, 0]),
    centerId,
    oneHop,
    twoHop,
    clusterCenters: new Map(),
    orbitRadii: [innerRadius, outerRadius],
  };
}

export function calculateLayout(
  mode: GraphViewMode,
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[],
  constellationPositions: PositionTuple[],
  graphRadius: number,
  selectedId?: string | null,
) {
  if (mode === "nebula") return nebulaLayout(nodes, graphRadius);
  if (mode === "orbit") {
    return orbitLayout(nodes, edges, graphRadius, selectedId);
  }
  return constellationLayout(constellationPositions);
}
