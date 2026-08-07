import fixtureJson from "../../../tests/fixtures/knowledge-graph/gold-memory-node-graph.json";
import type { Domain, KnowledgeEdge, KnowledgeNode, NodeKind, RelationKind } from "../../graph-data";
import { parseGitHubNodeSource } from "./source-metadata";
import type { GoldGraphFixture } from "./gold-graph-schema";
import { validateGoldGraphFixture } from "./gold-graph-schema";
import type { GraphSnapshot } from "./model";

const fixture = fixtureJson as GoldGraphFixture;

export function createGoldGraphSnapshot(): GraphSnapshot {
  const issues = validateGoldGraphFixture(fixture);
  if (issues.length) throw new Error(`Gold Graph fixture validation failed: ${issues.join("; ")}`);

  const nodes: KnowledgeNode[] = fixture.nodes.map((node) => {
    const sourceUrl = node.evidence[0]?.sourceUrl;
    const source = sourceUrl
      ? parseGitHubNodeSource(sourceUrl, fixture.repository.repositoryId) ?? undefined
      : undefined;
    return {
      id: node.id,
      label: node.label,
      shortLabel: node.label,
      kind: node.display.kind as NodeKind,
      domain: node.display.domain as Domain,
      summary: node.summary,
      insight: `${node.type.toUpperCase()} · ${node.evidence.length}개 근거 · ${node.status}`,
      tags: [
        `ontology:${node.type}`,
        node.type,
        node.status,
        ...node.aliases.map((alias) => `alias:${alias}`),
      ],
      source,
    };
  });
  const edges: KnowledgeEdge[] = fixture.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    type: edge.displayType as RelationKind,
    confidence: edge.confidence,
    note: `${edge.relation} · ${edge.note}`,
    layer: edge.layer,
    origin: edge.layer === "inferred" ? "codex" : edge.layer === "display" ? "display" : "rule",
    provider: edge.layer === "inferred" ? "gold-review" : "gold-fixture",
    evidence: edge.evidence.map((item) => ({
      blockId: item.blockId,
      explanation: `${edge.layer} · ${item.quote}`,
      sourceUrl: item.sourceUrl,
    })),
  }));

  return {
    nodes,
    edges,
    meta: {
      source: "demo",
      provider: "gold-graph-fixture",
      generatedAt: fixture.generatedAt,
      documentCount: fixture.selection.documentCount,
      repositoryId: fixture.repository.repositoryId,
      totalNodeCount: nodes.length,
      totalEdgeCount: edges.length,
      message: `ONTOLOGY V1 GOLD GRAPH REVIEW SAMPLE · ${fixture.selection.documentCount} documents · ${nodes.length} nodes · ${edges.length} evidence-backed relations · NOT FULL CORPUS`,
    },
  };
}
