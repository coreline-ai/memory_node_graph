import type { KnowledgeEdge, KnowledgeNode } from "../../graph-data";
import { resolveEntityAlias } from "./entity-alias-resolver";
import type { GraphSnapshot } from "./model";

const edgeKey = (edge: Pick<KnowledgeEdge, "source" | "target" | "type">) =>
  `${edge.source}|${edge.target}|${edge.type}`;

const semanticTags = new Set([
  "api", "storage", "technology", "file", "test", "risk", "decision",
  "phase", "task", "identifier", "component", "feature", "workflow",
]);

const isSemanticNode = (node: KnowledgeNode) =>
  node.tags.some((tag) => semanticTags.has(tag) || tag.startsWith("ontology:"));

const mergeEdge = (target: Map<string, KnowledgeEdge>, edge: KnowledgeEdge) => {
  const key = edgeKey(edge);
  const current = target.get(key);
  if (!current) {
    target.set(key, { ...edge, evidence: edge.evidence ? [...edge.evidence] : undefined });
    return;
  }
  current.confidence = Math.max(current.confidence, edge.confidence);
  const evidence = new Map((current.evidence ?? []).map((item) => [
    `${item.sourceUrl ?? ""}|${item.blockId}|${item.explanation}`,
    item,
  ]));
  for (const item of edge.evidence ?? []) {
    evidence.set(`${item.sourceUrl ?? ""}|${item.blockId}|${item.explanation}`, item);
  }
  current.evidence = [...evidence.values()].sort((left, right) =>
    (left.sourceUrl ?? "").localeCompare(right.sourceUrl ?? "")
    || left.blockId.localeCompare(right.blockId));
};

export function consolidateGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, { ...node, tags: [...node.tags] }]));
  const edges = new Map<string, KnowledgeEdge>();
  snapshot.edges.forEach((edge) => mergeEdge(edges, edge));
  const evidenceByNode = new Map<string, KnowledgeEdge["evidence"]>();
  for (const edge of snapshot.edges) {
    if (!edge.evidence?.length) continue;
    if (!evidenceByNode.has(edge.source)) evidenceByNode.set(edge.source, edge.evidence);
    if (!evidenceByNode.has(edge.target)) evidenceByNode.set(edge.target, edge.evidence);
  }

  for (const node of [...nodeById.values()]) {
    const alias = resolveEntityAlias(node.label);
    if (!alias || node.id === alias.canonicalId) continue;
    if (!node.tags.includes("technology") && !node.tags.includes("storage")) continue;
    if (!nodeById.has(alias.canonicalId)) {
      nodeById.set(alias.canonicalId, {
        ...node,
        id: alias.canonicalId,
        label: alias.label,
        shortLabel: alias.label,
        summary: `${alias.label} canonical 엔티티입니다.`,
        tags: [...new Set([...node.tags, "canonical", "shared", `alias:${node.label}`])],
      });
    }
    mergeEdge(edges, {
      source: node.id,
      target: alias.canonicalId,
      type: "same_as",
      confidence: 0.99,
      note: `${node.label}은 ${alias.label}의 확인된 별칭입니다.`,
      evidence: evidenceByNode.get(node.id),
      layer: "explicit",
      origin: "rule",
      provider: "entity-alias-resolver",
    });
  }

  const outgoingStructural = new Map<string, string[]>();
  for (const edge of edges.values()) {
    if (!["documents", "plans", "contains"].includes(edge.type)) continue;
    const targets = outgoingStructural.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoingStructural.set(edge.source, targets);
  }
  for (const targets of outgoingStructural.values()) targets.sort();

  const outgoingSemantic = new Map<string, KnowledgeEdge[]>();
  for (const edge of edges.values()) {
    const target = nodeById.get(edge.target);
    if (!target || !isSemanticNode(target)) continue;
    const rows = outgoingSemantic.get(edge.source) ?? [];
    rows.push(edge);
    outgoingSemantic.set(edge.source, rows);
  }
  for (const rows of outgoingSemantic.values()) rows.sort((left, right) =>
    edgeKey(left).localeCompare(edgeKey(right)));

  const documentNodes = [...nodeById.values()]
    .filter((node) => node.tags.includes("document") && !node.tags.includes("linked-document"))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const document of documentNodes) {
    const descendants = new Set<string>([document.id]);
    const queue = [document.id];
    for (let index = 0; index < queue.length; index += 1) {
      for (const targetId of outgoingStructural.get(queue[index]) ?? []) {
        const target = nodeById.get(targetId);
        if (!target || descendants.has(targetId)) continue;
        if (target.tags.includes("document") && targetId !== document.id) continue;
        descendants.add(targetId);
        queue.push(targetId);
      }
    }
    const mentions = new Map<string, KnowledgeEdge>();
    for (const sourceId of descendants) {
      for (const edge of outgoingSemantic.get(sourceId) ?? []) {
        if (edge.target === document.id) continue;
        const current = mentions.get(edge.target);
        if (!current || edge.confidence > current.confidence) mentions.set(edge.target, edge);
      }
    }
    for (const [targetId, evidenceEdge] of mentions) {
      mergeEdge(edges, {
        source: document.id,
        target: targetId,
        type: "mentions",
        confidence: Math.min(0.96, evidenceEdge.confidence),
        note: `${document.shortLabel}에서 ${nodeById.get(targetId)?.shortLabel ?? targetId}을 명시적으로 언급합니다.`,
        evidence: evidenceEdge.evidence,
        layer: evidenceEdge.layer === "inferred" ? "inferred" : "explicit",
        origin: evidenceEdge.origin === "codex" ? "codex" : "rule",
        provider: "repository-consolidation",
      });
    }
  }

  return {
    nodes: [...nodeById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
    meta: {
      ...snapshot.meta,
      message: snapshot.meta.message
        ? `${snapshot.meta.message} · canonical consolidation`
        : "Canonical entity consolidation 적용",
    },
  };
}
