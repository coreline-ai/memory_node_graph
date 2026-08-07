import type {
  Domain,
  KnowledgeEdge,
  KnowledgeNode,
  NodeKind,
  RelationKind,
} from "../../graph-data";
import type { GraphSnapshot } from "./model";

const kinds: NodeKind[] = ["thesis", "concept", "system", "tool", "practice", "risk"];
const domains: Domain[] = ["reasoning", "agents", "memory", "safety", "product", "infrastructure"];
const relations: RelationKind[] = [
  "documents", "plans", "contains", "supports", "extends",
  "requires", "uses", "mitigates", "risks", "contradicts",
];

export function createPerformanceGraphSnapshot(
  nodeCount = 500,
  edgeCount = 2_000,
): GraphSnapshot {
  const nodes: KnowledgeNode[] = Array.from({ length: nodeCount }, (_, index) => ({
    id: `perf-node-${index}`,
    label: `성능 기준 지식 노드 ${index + 1}`,
    shortLabel: `성능 노드 ${index + 1}`,
    kind: index % 41 === 0 ? "thesis" : kinds[index % kinds.length],
    domain: domains[index % domains.length],
    summary: "500개 노드와 2,000개 관계 렌더링을 검증하기 위한 결정적 로컬 fixture입니다.",
    insight: "실제 지식 데이터와 동일한 시각 계약을 사용하며 저장소에는 기록되지 않습니다.",
    tags: ["performance", `cluster-${index % domains.length}`],
  }));

  const edges: KnowledgeEdge[] = [];
  const keys = new Set<string>();
  let cursor = 0;
  while (edges.length < edgeCount) {
    const sourceIndex = cursor % nodeCount;
    const lane = Math.floor(cursor / nodeCount) + 1;
    const targetIndex = (sourceIndex * 17 + lane * 31 + 7) % nodeCount;
    const safeTarget = targetIndex === sourceIndex ? (targetIndex + 1) % nodeCount : targetIndex;
    const type = relations[cursor % relations.length];
    const key = `${sourceIndex}|${safeTarget}|${type}`;
    if (!keys.has(key)) {
      keys.add(key);
      edges.push({
        source: nodes[sourceIndex].id,
        target: nodes[safeTarget].id,
        type,
        confidence: 0.72 + (cursor % 24) / 100,
        note: `성능 fixture 관계 ${edges.length + 1}`,
        layer: cursor % 11 === 0 ? "display" : cursor % 7 === 0 ? "inferred" : cursor % 3 === 0 ? "explicit" : "structural",
        origin: "display",
        provider: "performance-fixture",
      });
    }
    cursor += 1;
  }

  return {
    nodes,
    edges,
    meta: {
      source: "demo",
      provider: "performance-fixture",
      generatedAt: new Date().toISOString(),
      documentCount: 0,
      message: "로컬 성능 검증용 500 노드·2,000 관계 fixture",
    },
  };
}
