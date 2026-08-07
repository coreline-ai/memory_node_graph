import type { KnowledgeEdge, KnowledgeNode } from "../../graph-data";
import type { GraphSnapshot } from "./model";
import { attachRepositoryNodeSources } from "./source-metadata.js";
import { analyzeGraphSnapshot, relationLayerFor } from "./analytics.js";

export const GRAPH_OVERVIEW_NODE_BUDGET = 500;
export const GRAPH_OVERVIEW_EDGE_BUDGET = 2_000;
export const GRAPH_CORPUS_NODE_BUDGET = 500;
export const GRAPH_CORPUS_EDGE_BUDGET = 2_000;
export const GRAPH_REPOSITORY_NODE_BUDGET = 500;
export const GRAPH_REPOSITORY_EDGE_BUDGET = 2_000;
export const GRAPH_SINGLE_REPOSITORY_OVERVIEW_NODE_TARGET = 120;
export const GRAPH_SINGLE_REPOSITORY_OVERVIEW_EDGE_TARGET = 400;

const byNodeIdentity = (left: KnowledgeNode, right: KnowledgeNode) =>
  left.label.localeCompare(right.label) || left.id.localeCompare(right.id);

const isRepositoryNode = (node: KnowledgeNode) =>
  node.id.startsWith("repository:github:")
  || (node.tags.includes("repository") && node.tags.includes("github"));

const isSharedTechnologyNode = (node: KnowledgeNode) =>
  node.tags.includes("technology") && node.tags.includes("shared");

const edgeKey = (edge: KnowledgeEdge) => `${edge.source}|${edge.target}|${edge.type}`;

const mergeEdges = (edges: readonly KnowledgeEdge[]) => {
  const merged = new Map<string, KnowledgeEdge>();
  const evidenceKeys = new Map<string, Set<string>>();
  for (const edge of edges) {
    const key = edgeKey(edge);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...edge, evidence: [] });
      evidenceKeys.set(key, new Set());
    } else {
      existing.confidence = Math.max(existing.confidence, edge.confidence);
      if (edge.note.localeCompare(existing.note) < 0) existing.note = edge.note;
    }
    const target = merged.get(key)!;
    const seen = evidenceKeys.get(key)!;
    for (const evidence of edge.evidence ?? []) {
      const evidenceKey = `${evidence.sourceUrl ?? ""}|${evidence.blockId}|${evidence.explanation}`;
      if (seen.has(evidenceKey)) continue;
      seen.add(evidenceKey);
      target.evidence!.push(evidence);
    }
  }
  for (const edge of merged.values()) {
    edge.evidence?.sort((left, right) =>
      (left.sourceUrl ?? "").localeCompare(right.sourceUrl ?? "")
      || left.blockId.localeCompare(right.blockId)
      || left.explanation.localeCompare(right.explanation));
    if (!edge.evidence?.length) delete edge.evidence;
  }
  return [...merged.values()];
};

const semanticNodeScore = (node: KnowledgeNode, degree: number) => {
  if (isRepositoryNode(node)) return 100_000;
  if (node.tags.includes("document")) return 8_000 + degree;
  if (node.tags.includes("plan")) return 7_500 + degree;
  if (node.tags.includes("api") || node.tags.includes("storage")) return 7_000 + degree * 8;
  if (node.tags.includes("technology") || node.tags.includes("component")) return 6_500 + degree * 8;
  if (node.tags.includes("risk") || node.tags.includes("decision")) return 6_000 + degree * 7;
  if (node.tags.includes("phase") || node.tags.includes("identifier")) return 5_500 + degree * 6;
  if (node.tags.includes("test") || node.tags.includes("feature")) return 5_000 + degree * 6;
  if (node.tags.includes("task")) return 3_000 + degree * 4;
  if (node.tags.includes("section")) return 2_000 + degree * 3;
  return 1_000 + degree;
};

const selectEdgesWithLayerBudget = (
  candidates: KnowledgeEdge[],
  edgeBudget: number,
) => {
  const quotas = {
    structural: Math.floor(edgeBudget * 0.3),
    explicit: Math.floor(edgeBudget * 0.45),
    inferred: Math.floor(edgeBudget * 0.2),
    display: Math.max(1, Math.floor(edgeBudget * 0.05)),
  };
  const sorted = [...candidates].sort((left, right) =>
    right.confidence - left.confidence || edgeKey(left).localeCompare(edgeKey(right)));
  const selected: KnowledgeEdge[] = [];
  const selectedKeys = new Set<string>();
  const selectedLayerCounts = { structural: 0, explicit: 0, inferred: 0, display: 0 };
  const selectedNodeDegrees = new Map<string, number>();
  const nodeEdgeCap = Math.max(24, Math.min(72, Math.ceil(edgeBudget / 10)));
  const canSelect = (edge: KnowledgeEdge) =>
    (selectedNodeDegrees.get(edge.source) ?? 0) < nodeEdgeCap
    && (selectedNodeDegrees.get(edge.target) ?? 0) < nodeEdgeCap;
  const select = (edge: KnowledgeEdge) => {
    selected.push(edge);
    selectedKeys.add(edgeKey(edge));
    selectedNodeDegrees.set(edge.source, (selectedNodeDegrees.get(edge.source) ?? 0) + 1);
    selectedNodeDegrees.set(edge.target, (selectedNodeDegrees.get(edge.target) ?? 0) + 1);
  };
  for (const layer of ["explicit", "inferred", "structural", "display"] as const) {
    for (const edge of sorted) {
      if (selected.length >= edgeBudget || relationLayerFor(edge) !== layer) continue;
      if (selectedLayerCounts[layer] >= quotas[layer]) break;
      if (!canSelect(edge)) continue;
      select(edge);
      selectedLayerCounts[layer] += 1;
    }
  }
  for (const edge of sorted) {
    if (selected.length >= edgeBudget) break;
    if (selectedKeys.has(edgeKey(edge))) continue;
    if (!canSelect(edge)) continue;
    select(edge);
  }
  return selected;
};

const corpusNodePriority = (node: KnowledgeNode, degree: number) => {
  const semanticBonus = node.tags.includes("technology") || node.tags.includes("component")
    ? 70
    : node.tags.includes("api") || node.tags.includes("storage")
      ? 60
      : node.tags.includes("risk") || node.tags.includes("decision")
        ? 50
        : node.tags.includes("phase") || node.tags.includes("plan")
          ? 40
          : node.tags.includes("document")
            ? 30
            : 0;
  return degree * 1_000 + semanticBonus;
};

const displayPairKey = (source: string, target: string) =>
  source < target ? `${source}|${target}` : `${target}|${source}`;

const CORPUS_WEAVE_IGNORED_TAGS = new Set([
  "canonical",
  "component",
  "completed",
  "concept",
  "document",
  "github",
  "pending",
  "plan",
  "repository",
  "section",
  "shared",
  "system",
  "task",
  "technology",
]);

const corpusWeaveTags = (node: KnowledgeNode) => new Set(node.tags.filter((tag) =>
  !CORPUS_WEAVE_IGNORED_TAGS.has(tag)
  && !tag.startsWith("alias:")
  && !tag.startsWith("source:")
  && !tag.startsWith("status:")
  && tag.length > 2));

/**
 * Adds a bounded, explicitly non-factual display weave to large corpus views.
 * The underlying D1 relations stay untouched; these edges only make the
 * selected factual clusters legible as one visual atlas and can be audited via
 * the `display` relation layer.
 */
const createCorpusDisplayWeave = (
  nodes: readonly KnowledgeNode[],
  factualEdges: readonly KnowledgeEdge[],
  edgeBudget: number,
) => {
  if (nodes.length < 250 || factualEdges.length >= edgeBudget) return [] as KnowledgeEdge[];
  const displayBudget = Math.min(edgeBudget - factualEdges.length, nodes.length * 2);
  if (displayBudget <= 0) return [] as KnowledgeEdge[];

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  const occupiedPairs = new Set<string>();
  for (const edge of factualEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    occupiedPairs.add(displayPairKey(edge.source, edge.target));
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const components: KnowledgeNode[][] = [];
  const visited = new Set<string>();
  for (const node of [...nodes].sort(byNodeIdentity)) {
    if (visited.has(node.id)) continue;
    const component: KnowledgeNode[] = [];
    const queue = [node.id];
    visited.add(node.id);
    for (let index = 0; index < queue.length; index += 1) {
      const current = nodeById.get(queue[index]);
      if (current) component.push(current);
      for (const neighbor of adjacency.get(queue[index]) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    component.sort((left, right) =>
      (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0)
      || corpusNodePriority(right, degree.get(right.id) ?? 0)
        - corpusNodePriority(left, degree.get(left.id) ?? 0)
      || byNodeIdentity(left, right));
    components.push(component);
  }
  components.sort((left, right) =>
    right.length - left.length || byNodeIdentity(left[0], right[0]));

  const displayEdges: KnowledgeEdge[] = [];
  const displayDegree = new Map(nodes.map((node) => [node.id, 0]));
  const addDisplayEdge = (source: KnowledgeNode, target: KnowledgeNode, note: string) => {
    if (displayEdges.length >= displayBudget || source.id === target.id) return false;
    const key = displayPairKey(source.id, target.id);
    if (occupiedPairs.has(key)) return false;
    occupiedPairs.add(key);
    displayDegree.set(source.id, (displayDegree.get(source.id) ?? 0) + 1);
    displayDegree.set(target.id, (displayDegree.get(target.id) ?? 0) + 1);
    displayEdges.push({
      source: source.id,
      target: target.id,
      type: "related_to",
      confidence: 0.38,
      note,
      layer: "display",
      origin: "display",
      provider: "corpus-visual-weave-v1",
    });
    return true;
  };

  // First make every selected factual component part of one visible atlas.
  for (let index = 1; index < components.length && displayEdges.length < displayBudget; index += 1) {
    addDisplayEdge(
      components[index - 1][0],
      components[index][0],
      "화면용 클러스터 브리지이며 사실 관계로 저장되지 않습니다.",
    );
  }

  const tagsById = new Map(nodes.map((node) => [node.id, corpusWeaveTags(node)]));
  const candidates: Array<{ source: KnowledgeNode; target: KnowledgeNode; score: number }> = [];
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const source = nodes[leftIndex];
    const sourceTags = tagsById.get(source.id)!;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const target = nodes[rightIndex];
      if (occupiedPairs.has(displayPairKey(source.id, target.id))) continue;
      const targetTags = tagsById.get(target.id)!;
      let sharedTags = 0;
      for (const tag of sourceTags) if (targetTags.has(tag)) sharedTags += 1;
      const score = sharedTags * 12
        + (source.domain === target.domain ? 4 : 0)
        + (source.kind === target.kind ? 2 : 0)
        + (isRepositoryNode(source) || isRepositoryNode(target) ? -3 : 0);
      if (score > 0) candidates.push({ source, target, score });
    }
  }
  candidates.sort((left, right) =>
    right.score - left.score
    || displayPairKey(left.source.id, left.target.id)
      .localeCompare(displayPairKey(right.source.id, right.target.id)));
  const displayDegreeCap = Math.max(4, Math.ceil(displayBudget * 2 / nodes.length) + 3);
  for (const candidate of candidates) {
    if (displayEdges.length >= displayBudget) break;
    if ((displayDegree.get(candidate.source.id) ?? 0) >= displayDegreeCap
      || (displayDegree.get(candidate.target.id) ?? 0) >= displayDegreeCap) continue;
    addDisplayEdge(
      candidate.source,
      candidate.target,
      "공유 태그·분야 기반 화면용 의미 근접선이며 사실 관계로 저장되지 않습니다.",
    );
  }

  // Sparse or weakly tagged corpora still receive a deterministic low-degree
  // ring so the force layout does not split into isolated islands.
  const ring = [...nodes].sort((left, right) =>
    left.domain.localeCompare(right.domain)
    || left.kind.localeCompare(right.kind)
    || byNodeIdentity(left, right));
  for (const stride of [1, 7, 19, 37]) {
    for (let index = 0; index < ring.length && displayEdges.length < displayBudget; index += 1) {
      const source = ring[index];
      const target = ring[(index + stride) % ring.length];
      if ((displayDegree.get(source.id) ?? 0) >= displayDegreeCap + 1
        || (displayDegree.get(target.id) ?? 0) >= displayDegreeCap + 1) continue;
      addDisplayEdge(
        source,
        target,
        "전체 코퍼스 배치를 위한 화면용 연결선이며 사실 관계로 저장되지 않습니다.",
      );
    }
  }
  return displayEdges;
};

/**
 * Builds a deterministic, relationship-first view of the whole corpus. It
 * never invents factual edges: seeds are high-degree/repository nodes, then
 * their most strongly connected neighbours fill the visual budget.
 */
export function projectGraphCorpus(
  snapshot: GraphSnapshot,
  options: { nodeBudget?: number; edgeBudget?: number } = {},
): GraphSnapshot {
  const nodeBudget = Math.max(1, Math.min(
    GRAPH_CORPUS_NODE_BUDGET,
    Math.floor(options.nodeBudget ?? GRAPH_CORPUS_NODE_BUDGET),
  ));
  const edgeBudget = Math.max(1, Math.min(
    GRAPH_CORPUS_EDGE_BUDGET,
    Math.floor(options.edgeBudget ?? GRAPH_CORPUS_EDGE_BUDGET),
  ));
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = mergeEdges(snapshot.edges.filter((edge) =>
    nodeById.has(edge.source) && nodeById.has(edge.target)));
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const rankedNodes = [...snapshot.nodes].sort((left, right) =>
    corpusNodePriority(right, degree.get(right.id) ?? 0)
    - corpusNodePriority(left, degree.get(left.id) ?? 0)
    || byNodeIdentity(left, right));
  const repositoryTarget = Math.min(24, Math.max(1, Math.floor(nodeBudget * 0.12)));
  const repositories = rankedNodes.filter(isRepositoryNode).slice(0, repositoryTarget);
  const anchorTarget = Math.min(40, Math.max(0, nodeBudget - repositories.length));
  const anchors = rankedNodes
    .filter((node) => !isRepositoryNode(node))
    .slice(0, anchorTarget);
  const selectedIds = new Set([...repositories, ...anchors].map((node) => node.id));
  const adjacency = new Map<string, KnowledgeEdge[]>();
  for (const edge of edges) {
    const sourceEdges = adjacency.get(edge.source) ?? [];
    sourceEdges.push(edge);
    adjacency.set(edge.source, sourceEdges);
    const targetEdges = adjacency.get(edge.target) ?? [];
    targetEdges.push(edge);
    adjacency.set(edge.target, targetEdges);
  }

  const gain = new Map<string, number>();
  const addConnectedGains = (selectedId: string) => {
    for (const edge of adjacency.get(selectedId) ?? []) {
      const candidateId = edge.source === selectedId ? edge.target : edge.source;
      if (selectedIds.has(candidateId)) continue;
      const candidate = nodeById.get(candidateId);
      if (!candidate || isRepositoryNode(candidate)) continue;
      const layer = relationLayerFor(edge);
      if (layer === "display") continue;
      const layerWeight = layer === "explicit" ? 0.3 : layer === "inferred" ? 0.24 : 0.12;
      gain.set(candidateId, (gain.get(candidateId) ?? 0) + 1 + layerWeight + edge.confidence * 0.1);
    }
  };
  for (const seedId of selectedIds) addConnectedGains(seedId);
  while (selectedIds.size < nodeBudget && gain.size) {
    let best: KnowledgeNode | null = null;
    let bestGain = Number.NEGATIVE_INFINITY;
    for (const [candidateId, candidateGain] of gain) {
      const candidate = nodeById.get(candidateId);
      if (!candidate || selectedIds.has(candidateId)) {
        gain.delete(candidateId);
        continue;
      }
      if (
        candidateGain > bestGain
        || (candidateGain === bestGain && best && (
          corpusNodePriority(candidate, degree.get(candidate.id) ?? 0)
            > corpusNodePriority(best, degree.get(best.id) ?? 0)
          || (corpusNodePriority(candidate, degree.get(candidate.id) ?? 0)
              === corpusNodePriority(best, degree.get(best.id) ?? 0)
            && byNodeIdentity(candidate, best) < 0)
        ))
        || best === null
      ) {
        best = candidate;
        bestGain = candidateGain;
      }
    }
    if (!best) break;
    selectedIds.add(best.id);
    gain.delete(best.id);
    addConnectedGains(best.id);
  }
  for (const node of rankedNodes) {
    if (selectedIds.size >= nodeBudget) break;
    if (isRepositoryNode(node) && !selectedIds.has(node.id)) continue;
    selectedIds.add(node.id);
  }
  const nodes = snapshot.nodes
    .filter((node) => selectedIds.has(node.id))
    .sort((left, right) =>
      corpusNodePriority(right, degree.get(right.id) ?? 0)
      - corpusNodePriority(left, degree.get(left.id) ?? 0)
      || byNodeIdentity(left, right));
  const connectedEdges = edges.filter((edge) =>
    selectedIds.has(edge.source)
    && selectedIds.has(edge.target)
    && relationLayerFor(edge) !== "display");
  const layerPriority = { explicit: 0, inferred: 1, structural: 2, display: 3 } as const;
  connectedEdges.sort((left, right) =>
    layerPriority[relationLayerFor(left)] - layerPriority[relationLayerFor(right)]
    || right.confidence - left.confidence
    || edgeKey(left).localeCompare(edgeKey(right)));
  const factualEdges = connectedEdges.slice(0, edgeBudget);
  const displayEdges = createCorpusDisplayWeave(nodes, factualEdges, edgeBudget);
  const selectedEdges = [...factualEdges, ...displayEdges];
  const corpusNodeCount = snapshot.meta.corpusNodeCount ?? snapshot.meta.totalNodeCount ?? snapshot.nodes.length;
  const corpusEdgeCount = snapshot.meta.corpusEdgeCount ?? snapshot.meta.totalEdgeCount ?? snapshot.edges.length;

  return {
    nodes,
    edges: selectedEdges,
    meta: {
      ...snapshot.meta,
      scope: "corpus",
      projectionMode: "full-corpus-knowledge-map",
      nodeBudget,
      edgeBudget,
      corpusNodeCount,
      corpusEdgeCount,
      totalNodeCount: corpusNodeCount,
      omittedNodeCount: Math.max(0, corpusNodeCount - nodes.length),
      totalEdgeCount: corpusEdgeCount,
      omittedEdgeCount: Math.max(0, corpusEdgeCount - factualEdges.length),
      projectedFactualEdgeCount: factualEdges.length,
      displayEdgeCount: displayEdges.length,
      message: `전체 D1에서 관계 중심 핵심 노드 ${nodes.length}개와 실제 관계 ${factualEdges.length}개를 투영하고 화면용 연결선 ${displayEdges.length}개를 더했습니다.`,
    },
  };
}

function projectSingleRepositoryOverview(
  snapshot: GraphSnapshot,
  repository: KnowledgeNode,
  options: { nodeBudget?: number; edgeBudget?: number },
): GraphSnapshot {
  const nodeBudget = Math.max(1, Math.min(
    GRAPH_OVERVIEW_NODE_BUDGET,
    Math.floor(options.nodeBudget ?? GRAPH_SINGLE_REPOSITORY_OVERVIEW_NODE_TARGET),
  ));
  const edgeBudget = Math.max(1, Math.min(
    GRAPH_OVERVIEW_EDGE_BUDGET,
    Math.floor(options.edgeBudget ?? GRAPH_SINGLE_REPOSITORY_OVERVIEW_EDGE_TARGET),
  ));
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const factualEdges = mergeEdges(snapshot.edges.filter((edge) =>
    nodeById.has(edge.source) && nodeById.has(edge.target) && relationLayerFor(edge) !== "display"));
  const outgoing = new Map<string, KnowledgeEdge[]>();
  for (const edge of factualEdges) {
    const rows = outgoing.get(edge.source) ?? [];
    rows.push(edge);
    outgoing.set(edge.source, rows);
  }
  const reachableIds = new Set([repository.id]);
  const queue = [repository.id];
  for (let index = 0; index < queue.length; index += 1) {
    for (const edge of outgoing.get(queue[index]) ?? []) {
      const target = nodeById.get(edge.target);
      if (!target || reachableIds.has(target.id)) continue;
      if (isRepositoryNode(target) && target.id !== repository.id) continue;
      reachableIds.add(target.id);
      if (!target.tags.includes("shared")) queue.push(target.id);
    }
  }
  const reachableNodes = [...reachableIds].map((id) => nodeById.get(id)!).filter(Boolean);
  const reachableEdges = factualEdges.filter((edge) =>
    reachableIds.has(edge.source) && reachableIds.has(edge.target));
  const analyzed = analyzeGraphSnapshot({
    nodes: reachableNodes,
    edges: reachableEdges,
    meta: snapshot.meta,
  });
  const degree = new Map(analyzed.nodes.map((node) => [node.id, node.metrics?.degree ?? 0]));
  const communities = new Map<string, KnowledgeNode[]>();
  for (const node of analyzed.nodes) {
    const id = node.metrics?.communityId ?? "community-00";
    const rows = communities.get(id) ?? [];
    rows.push(node);
    communities.set(id, rows);
  }
  for (const rows of communities.values()) rows.sort((left, right) =>
    semanticNodeScore(right, degree.get(right.id) ?? 0) - semanticNodeScore(left, degree.get(left.id) ?? 0)
    || (right.metrics?.centrality ?? 0) - (left.metrics?.centrality ?? 0)
    || byNodeIdentity(left, right));
  const selectedIds = new Set<string>([repository.id]);
  const orderedCommunities = [...communities.entries()].sort((left, right) =>
    right[1].length - left[1].length || left[0].localeCompare(right[0]));
  for (let round = 0; selectedIds.size < nodeBudget; round += 1) {
    let added = 0;
    for (const [, rows] of orderedCommunities) {
      const candidate = rows[round];
      if (!candidate || selectedIds.has(candidate.id)) continue;
      selectedIds.add(candidate.id);
      added += 1;
      if (selectedIds.size >= nodeBudget) break;
    }
    if (!added) break;
  }
  const selectedNodes = analyzed.nodes.filter((node) => selectedIds.has(node.id));
  const communityRepresentatives = [...communities.values()]
    .map((rows) => rows.find((node) => selectedIds.has(node.id)))
    .filter((node): node is KnowledgeNode => Boolean(node))
    .sort(byNodeIdentity);
  const displayEdges: KnowledgeEdge[] = communityRepresentatives.slice(0, -1).map((node, index) => ({
    source: node.id,
    target: communityRepresentatives[index + 1].id,
    type: "related_to",
    confidence: 0.42,
    note: "화면용 커뮤니티 브리지이며 사실 관계로 저장되지 않습니다.",
    layer: "display",
    origin: "display",
    provider: "adaptive-overview-projector",
  }));
  const connectedEdges = [...reachableEdges, ...displayEdges].filter((edge) =>
    selectedIds.has(edge.source) && selectedIds.has(edge.target));
  const selectedEdges = selectEdgesWithLayerBudget(connectedEdges, edgeBudget);
  const repositoryId = repository.id.slice("repository:github:".length);
  return {
    nodes: attachRepositoryNodeSources(selectedNodes, reachableEdges, repositoryId),
    edges: selectedEdges,
    meta: {
      ...snapshot.meta,
      analytics: analyzed.meta.analytics,
      scope: "overview",
      projectionMode: "single-repository-knowledge-map",
      repositoryCount: 1,
      repositoryId,
      documentCount: reachableNodes.filter((node) => node.tags.includes("document")).length,
      nodeBudget,
      edgeBudget,
      totalNodeCount: reachableNodes.length,
      omittedNodeCount: Math.max(0, reachableNodes.length - selectedNodes.length),
      totalEdgeCount: connectedEdges.length,
      omittedEdgeCount: Math.max(0, connectedEdges.length - selectedEdges.length),
      message: `단일 저장소 내부 커뮤니티 ${analyzed.meta.analytics?.communityCount ?? 0}개와 대표 의미 노드를 투영했습니다.`,
    },
  };
}

export function projectGraphOverview(
  snapshot: GraphSnapshot,
  options: { nodeBudget?: number; edgeBudget?: number } = {},
): GraphSnapshot {
  const nodeBudget = Math.max(1, Math.floor(options.nodeBudget ?? GRAPH_OVERVIEW_NODE_BUDGET));
  const edgeBudget = Math.max(1, Math.floor(options.edgeBudget ?? GRAPH_OVERVIEW_EDGE_BUDGET));
  const repositories = snapshot.nodes.filter(isRepositoryNode).sort(byNodeIdentity);
  if (repositories.length === 1) {
    return projectSingleRepositoryOverview(snapshot, repositories[0], options);
  }
  const repositoryIds = new Set(repositories.map((node) => node.id));
  const technologies = snapshot.nodes.filter(isSharedTechnologyNode);
  const technologyIds = new Set(technologies.map((node) => node.id));
  const eligibleEdges = mergeEdges(snapshot.edges.filter((edge) => {
    const sourceRepository = repositoryIds.has(edge.source);
    const targetRepository = repositoryIds.has(edge.target);
    const sourceTechnology = technologyIds.has(edge.source);
    const targetTechnology = technologyIds.has(edge.target);
    return (sourceRepository && targetRepository)
      || (sourceRepository && targetTechnology)
      || (targetRepository && sourceTechnology);
  }));
  const repositoryConnections = new Map<string, Set<string>>();
  const degrees = new Map<string, number>();
  for (const edge of eligibleEdges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
    const technologyId = technologyIds.has(edge.source) ? edge.source
      : technologyIds.has(edge.target) ? edge.target : undefined;
    const repositoryId = repositoryIds.has(edge.source) ? edge.source
      : repositoryIds.has(edge.target) ? edge.target : undefined;
    if (technologyId && repositoryId) {
      const connected = repositoryConnections.get(technologyId) ?? new Set<string>();
      connected.add(repositoryId);
      repositoryConnections.set(technologyId, connected);
    }
  }
  const connectedTechnologies = technologies.filter((node) =>
    (repositoryConnections.get(node.id)?.size ?? 0) > 0);
  connectedTechnologies.sort((left, right) =>
    (repositoryConnections.get(right.id)?.size ?? 0) - (repositoryConnections.get(left.id)?.size ?? 0)
    || (degrees.get(right.id) ?? 0) - (degrees.get(left.id) ?? 0)
    || byNodeIdentity(left, right));

  const selectedRepositories = repositories.slice(0, nodeBudget);
  const remaining = Math.max(0, nodeBudget - selectedRepositories.length);
  const sourcedRepositories = selectedRepositories.map((node) => {
    const repositoryId = node.id.slice("repository:github:".length);
    return attachRepositoryNodeSources(
      [node],
      eligibleEdges.filter((edge) => edge.source === node.id || edge.target === node.id),
      repositoryId,
    )[0];
  });
  const nodes = [...sourcedRepositories, ...connectedTechnologies.slice(0, remaining)];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connectedEdges = eligibleEdges.filter((edge) =>
    nodeIds.has(edge.source) && nodeIds.has(edge.target));
  connectedEdges.sort((left, right) => {
    const leftDirect = repositoryIds.has(left.source) && repositoryIds.has(left.target) ? 1 : 0;
    const rightDirect = repositoryIds.has(right.source) && repositoryIds.has(right.target) ? 1 : 0;
    return rightDirect - leftDirect
      || right.confidence - left.confidence
      || edgeKey(left).localeCompare(edgeKey(right));
  });
  const eligibleNodeCount = repositories.length + connectedTechnologies.length;

  return {
    nodes,
    edges: connectedEdges.slice(0, edgeBudget),
    meta: {
      ...snapshot.meta,
      scope: "overview",
      projectionMode: "multi-repository-shared-knowledge",
      repositoryCount: repositories.length,
      nodeBudget,
      edgeBudget,
      totalNodeCount: eligibleNodeCount,
      omittedNodeCount: Math.max(0, eligibleNodeCount - nodes.length),
      totalEdgeCount: eligibleEdges.length,
      omittedEdgeCount: Math.max(0, eligibleEdges.length - Math.min(connectedEdges.length, edgeBudget)),
      message: repositories.length
        ? snapshot.meta.message
        : "동기화된 GitHub 저장소가 없습니다. 대시보드에서 저장소를 적용하세요.",
    },
  };
}

const repositoryTraversalPriority = (node: KnowledgeNode) => {
  if (node.tags.includes("document")) return 0;
  if (node.tags.includes("plan")) return 1;
  if (node.tags.includes("phase")) return 2;
  if (node.tags.includes("task")) return 3;
  if (node.tags.includes("section")) return 4;
  if (node.tags.includes("shared")) return 6;
  return 5;
};

const repositoryRelationPriority = (edge: KnowledgeEdge) => {
  if (edge.type === "documents") return 0;
  if (edge.type === "plans") return 1;
  if (edge.type === "contains") return 2;
  if (edge.type === "requires" || edge.type === "risks") return 3;
  return 4;
};

export function projectGraphRepository(
  snapshot: GraphSnapshot,
  repositoryId: string,
  options: { nodeBudget?: number; edgeBudget?: number } = {},
): GraphSnapshot | null {
  const nodeBudget = Math.max(1, Math.floor(options.nodeBudget ?? GRAPH_REPOSITORY_NODE_BUDGET));
  const edgeBudget = Math.max(1, Math.floor(options.edgeBudget ?? GRAPH_REPOSITORY_EDGE_BUDGET));
  const repositoryNodeId = `repository:github:${repositoryId}`;
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const repository = nodeById.get(repositoryNodeId);
  if (!repository || !isRepositoryNode(repository)) return null;

  const allEdges = mergeEdges(snapshot.edges.filter((edge) =>
    nodeById.has(edge.source) && nodeById.has(edge.target)));
  const outgoing = new Map<string, KnowledgeEdge[]>();
  for (const edge of allEdges) {
    const edges = outgoing.get(edge.source) ?? [];
    edges.push(edge);
    outgoing.set(edge.source, edges);
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) => {
      const leftTarget = nodeById.get(left.target)!;
      const rightTarget = nodeById.get(right.target)!;
      return repositoryTraversalPriority(leftTarget) - repositoryTraversalPriority(rightTarget)
        || repositoryRelationPriority(left) - repositoryRelationPriority(right)
        || byNodeIdentity(leftTarget, rightTarget)
        || edgeKey(left).localeCompare(edgeKey(right));
    });
  }

  const reachableIds = new Set<string>([repositoryNodeId]);
  const traversalOrder = [repositoryNodeId];
  const sharedLeafIds = new Set<string>();
  for (let index = 0; index < traversalOrder.length; index += 1) {
    const currentId = traversalOrder[index];
    for (const edge of outgoing.get(currentId) ?? []) {
      const target = nodeById.get(edge.target)!;
      if (isRepositoryNode(target) && target.id !== repositoryNodeId) continue;
      if (reachableIds.has(target.id)) continue;
      reachableIds.add(target.id);
      if (target.tags.includes("shared")) {
        sharedLeafIds.add(target.id);
        continue;
      }
      traversalOrder.push(target.id);
    }
  }
  traversalOrder.push(...[...sharedLeafIds]
    .map((id) => nodeById.get(id)!)
    .sort(byNodeIdentity)
    .map((node) => node.id));

  const degreeById = new Map<string, number>();
  for (const edge of allEdges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + 1);
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + 1);
  }

  const selectedIds = traversalOrder.length <= nodeBudget
    ? traversalOrder
    : [repositoryNodeId, ...traversalOrder.slice(1).sort((leftId, rightId) => {
      const left = nodeById.get(leftId)!;
      const right = nodeById.get(rightId)!;
      const leftDegree = degreeById.get(leftId) ?? 0;
      const rightDegree = degreeById.get(rightId) ?? 0;
      return semanticNodeScore(right, rightDegree) - semanticNodeScore(left, leftDegree)
        || byNodeIdentity(left, right);
    }).slice(0, nodeBudget - 1)];
  const selectedIdSet = new Set(selectedIds);
  const connectedEdges = allEdges.filter((edge) =>
    selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target));
  connectedEdges.sort((left, right) =>
    repositoryRelationPriority(left) - repositoryRelationPriority(right)
    || right.confidence - left.confidence
    || edgeKey(left).localeCompare(edgeKey(right)));
  const edges = selectEdgesWithLayerBudget(connectedEdges, edgeBudget);
  const reachableEdges = allEdges.filter((edge) =>
    reachableIds.has(edge.source) && reachableIds.has(edge.target));

  return {
    nodes: attachRepositoryNodeSources(
      selectedIds.map((id) => nodeById.get(id)!),
      reachableEdges,
      repositoryId,
    ),
    edges,
    meta: {
      ...snapshot.meta,
      scope: "repository",
      projectionMode: "repository-evidence-graph",
      repositoryId,
      repositoryCount: 1,
      documentCount: [...reachableIds]
        .map((id) => nodeById.get(id)!)
        .filter((node) => node.tags.includes("document")).length,
      nodeBudget,
      edgeBudget,
      totalNodeCount: reachableIds.size,
      omittedNodeCount: Math.max(0, reachableIds.size - selectedIds.length),
      totalEdgeCount: reachableEdges.length,
      omittedEdgeCount: Math.max(0, reachableEdges.length - edges.length),
    },
  };
}
