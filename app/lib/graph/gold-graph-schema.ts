export const GOLD_NODE_TYPES = [
  "project",
  "repository",
  "document",
  "component",
  "feature",
  "workflow",
  "api",
  "data",
  "storage",
  "file",
  "technology",
  "decision",
  "risk",
  "test",
  "phase",
  "task",
] as const;

export const GOLD_RELATION_TYPES = [
  "documents",
  "plans",
  "contains",
  "implements",
  "depends_on",
  "calls",
  "reads_from",
  "writes_to",
  "produces",
  "tests",
  "references",
  "precedes",
  "blocks",
  "supersedes",
  "same_as",
  "mentions",
  "related_to",
  "supports",
  "extends",
  "requires",
  "uses",
  "mitigates",
  "risks",
  "contradicts",
] as const;

export type GoldNodeType = typeof GOLD_NODE_TYPES[number];
export type GoldRelationType = typeof GOLD_RELATION_TYPES[number];
export type GoldRelationLayer = "structural" | "explicit" | "inferred" | "display";

export type GoldEvidence = {
  documentId: string;
  blockId: string;
  sourceUrl: string;
  quote: string;
};

export type GoldGraphFixture = {
  version: string;
  ontologyVersion: string;
  generatedAt: string;
  readOnly: true;
  repository: {
    repositoryId: string;
    owner: string;
    name: string;
    commitSha: string;
  };
  selection: {
    rationale: string;
    documentCount: number;
    nodeTarget: string;
  };
  nodes: Array<{
    id: string;
    label: string;
    type: GoldNodeType;
    status: "current" | "historical" | "candidate";
    aliases: string[];
    summary: string;
    display: {
      kind: "thesis" | "concept" | "system" | "tool" | "practice" | "risk";
      domain: "reasoning" | "agents" | "memory" | "safety" | "product" | "infrastructure";
    };
    evidence: GoldEvidence[];
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    relation: GoldRelationType;
    displayType: "documents" | "plans" | "contains" | "supports" | "extends" | "requires" | "uses" | "mitigates" | "risks" | "contradicts";
    layer: GoldRelationLayer;
    confidence: number;
    note: string;
    evidence: GoldEvidence[];
  }>;
};

const NODE_TYPE_SET = new Set<string>(GOLD_NODE_TYPES);
const RELATION_TYPE_SET = new Set<string>(GOLD_RELATION_TYPES);
const NODE_KIND_SET = new Set(["thesis", "concept", "system", "tool", "practice", "risk"]);
const DOMAIN_SET = new Set(["reasoning", "agents", "memory", "safety", "product", "infrastructure"]);
const DISPLAY_RELATION_SET = new Set([
  "documents", "plans", "contains", "supports", "extends",
  "requires", "uses", "mitigates", "risks", "contradicts",
]);
const LAYER_SET = new Set(["structural", "explicit", "inferred", "display"]);
const TEMPLATE_LABELS = new Set([
  "구현 태스크", "자체 테스트", "목표", "완료 조건",
  "이슈 및 수정", "발견 이슈 없음", "QA 관점", "Phase 상태 요약",
]);

const relationMinimumConfidence: Record<GoldRelationType, number> = {
  documents: 1,
  plans: 0.95,
  contains: 1,
  implements: 0.85,
  depends_on: 0.8,
  calls: 0.9,
  reads_from: 0.9,
  writes_to: 0.9,
  produces: 0.85,
  tests: 0.9,
  references: 0.95,
  precedes: 0.9,
  blocks: 0.85,
  supersedes: 0.9,
  same_as: 0.95,
  mentions: 0.7,
  related_to: 0.7,
  supports: 0.8,
  extends: 0.85,
  requires: 0.85,
  uses: 0.9,
  mitigates: 0.8,
  risks: 0.8,
  contradicts: 0.85,
};

const hasType = (type: string, allowed: readonly string[]) => allowed.includes(type);

export function isAllowedGoldRelationPattern(
  relation: GoldRelationType,
  sourceType: GoldNodeType,
  targetType: GoldNodeType,
) {
  switch (relation) {
    case "documents":
      return hasType(sourceType, ["project", "repository"]) && targetType === "document";
    case "plans":
      return sourceType === "document" && hasType(targetType, ["project", "component", "feature", "workflow"]);
    case "contains":
      return hasType(sourceType, ["project", "repository", "document", "component", "workflow", "phase"])
        && hasType(targetType, ["document", "component", "workflow", "feature", "api", "data", "storage", "phase", "task"]);
    case "implements":
      return hasType(sourceType, ["project", "component"])
        && hasType(targetType, ["feature", "api", "workflow"]);
    case "depends_on":
      return hasType(sourceType, ["project", "component", "feature", "workflow"])
        && hasType(targetType, ["component", "technology", "storage", "api", "data"]);
    case "calls":
      return hasType(sourceType, ["component", "feature", "workflow", "api"])
        && hasType(targetType, ["api", "component", "workflow"]);
    case "reads_from":
      return hasType(sourceType, ["component", "feature", "workflow", "api"])
        && hasType(targetType, ["storage", "data"]);
    case "writes_to":
      return hasType(sourceType, ["component", "workflow", "api"])
        && targetType === "storage";
    case "produces":
      return hasType(sourceType, ["component", "workflow", "api"])
        && hasType(targetType, ["data", "document"]);
    case "tests":
      return sourceType === "test"
        && hasType(targetType, ["project", "component", "feature", "api", "workflow"]);
    case "references":
      return hasType(sourceType, ["document", "file", "task"])
        && hasType(targetType, ["document", "file", "api", "technology"]);
    case "precedes":
      return hasType(sourceType, ["workflow", "phase", "task"])
        && hasType(targetType, ["workflow", "phase", "task"]);
    case "blocks":
      return hasType(sourceType, ["risk", "task"])
        && hasType(targetType, ["feature", "workflow", "phase", "task"]);
    case "supersedes":
      return hasType(sourceType, ["decision", "phase", "document"])
        && sourceType === targetType;
    case "same_as":
      return sourceType === targetType;
    case "mentions":
      return sourceType === "document";
    case "related_to":
      return hasType(sourceType, ["project", "component", "feature", "technology"])
        && sourceType === targetType;
    case "supports":
      return hasType(sourceType, ["component", "feature", "workflow", "decision", "test"])
        && hasType(targetType, ["project", "component", "feature", "workflow", "decision"]);
    case "extends":
      return hasType(sourceType, ["project", "component", "feature", "api"])
        && sourceType === targetType;
    case "requires":
      return hasType(sourceType, ["project", "component", "feature", "workflow", "decision"])
        && hasType(targetType, ["component", "workflow", "technology", "storage", "data", "decision"]);
    case "uses":
      return hasType(sourceType, ["project", "component", "workflow"])
        && hasType(targetType, ["technology", "api", "storage"]);
    case "mitigates":
      return hasType(sourceType, ["decision", "test", "component"])
        && targetType === "risk";
    case "risks":
      return hasType(sourceType, ["project", "component", "workflow", "decision"])
        && targetType === "risk";
    case "contradicts":
      return hasType(sourceType, ["decision", "document"]) && sourceType === targetType;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function evidenceIssues(
  value: unknown,
  location: string,
  repository: GoldGraphFixture["repository"] | null,
) {
  const issues: string[] = [];
  if (!Array.isArray(value) || value.length === 0) return [`${location}.evidence must not be empty`];
  value.forEach((item, index) => {
    const prefix = `${location}.evidence[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${prefix} must be an object`);
      return;
    }
    const documentId = typeof item.documentId === "string" ? item.documentId : "";
    const blockId = typeof item.blockId === "string" ? item.blockId : "";
    const sourceUrl = typeof item.sourceUrl === "string" ? item.sourceUrl : "";
    if (!/^document-[0-9a-f]{64}$/.test(documentId)) issues.push(`${prefix}.documentId is invalid`);
    if (!new RegExp(`^block:${documentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:-?\\d+$`).test(blockId)) {
      issues.push(`${prefix}.blockId does not belong to documentId`);
    }
    if (typeof item.quote !== "string" || !item.quote.trim()) issues.push(`${prefix}.quote is empty`);
    try {
      const url = new URL(sourceUrl);
      if (
        !repository
        || url.protocol !== "https:"
        || url.hostname !== "github.com"
        || !url.pathname.startsWith(`/${repository.owner}/${repository.name}/blob/${repository.commitSha}/`)
        || !/^#L[1-9]\d*(?:-L[1-9]\d*)?$/.test(url.hash)
      ) issues.push(`${prefix}.sourceUrl is not a commit-pinned repository line URL`);
    } catch {
      issues.push(`${prefix}.sourceUrl is invalid`);
    }
  });
  return issues;
}

export function validateGoldGraphFixture(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["fixture must be an object"];
  const repository = isRecord(value.repository)
    && typeof value.repository.repositoryId === "string"
    && typeof value.repository.owner === "string"
    && typeof value.repository.name === "string"
    && typeof value.repository.commitSha === "string"
    ? value.repository as GoldGraphFixture["repository"]
    : null;
  if (!repository || !/^[0-9a-f]{40}$/.test(repository.commitSha)) issues.push("repository identity is invalid");
  if (value.readOnly !== true) issues.push("fixture must be readOnly");
  if (value.ontologyVersion !== "knowledge-graph-ontology-v1") issues.push("ontologyVersion is invalid");
  if (!Array.isArray(value.nodes) || value.nodes.length < 40 || value.nodes.length > 80) {
    issues.push("fixture must contain 40-80 nodes");
  }
  if (!Array.isArray(value.edges) || value.edges.length === 0) issues.push("fixture edges must not be empty");

  const nodeTypes = new Map<string, GoldNodeType>();
  const seenNodeIds = new Set<string>();
  for (const [index, nodeValue] of (Array.isArray(value.nodes) ? value.nodes : []).entries()) {
    const location = `nodes[${index}]`;
    if (!isRecord(nodeValue)) {
      issues.push(`${location} must be an object`);
      continue;
    }
    const id = typeof nodeValue.id === "string" ? nodeValue.id : "";
    const label = typeof nodeValue.label === "string" ? nodeValue.label.trim() : "";
    const type = typeof nodeValue.type === "string" ? nodeValue.type : "";
    if (!/^gold:[a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/.test(id)) issues.push(`${location}.id is invalid`);
    if (seenNodeIds.has(id)) issues.push(`${location}.id is duplicated`);
    seenNodeIds.add(id);
    if (!label) issues.push(`${location}.label is empty`);
    if (TEMPLATE_LABELS.has(label)) issues.push(`${location}.label is a template heading`);
    if (!NODE_TYPE_SET.has(type)) issues.push(`${location}.type is invalid`);
    else nodeTypes.set(id, type as GoldNodeType);
    if (!isRecord(nodeValue.display)
      || !NODE_KIND_SET.has(String(nodeValue.display.kind))
      || !DOMAIN_SET.has(String(nodeValue.display.domain))) issues.push(`${location}.display is invalid`);
    issues.push(...evidenceIssues(nodeValue.evidence, location, repository));
  }

  const seenEdgeIds = new Set<string>();
  const seenEdgeKeys = new Set<string>();
  for (const [index, edgeValue] of (Array.isArray(value.edges) ? value.edges : []).entries()) {
    const location = `edges[${index}]`;
    if (!isRecord(edgeValue)) {
      issues.push(`${location} must be an object`);
      continue;
    }
    const id = typeof edgeValue.id === "string" ? edgeValue.id : "";
    const source = typeof edgeValue.source === "string" ? edgeValue.source : "";
    const target = typeof edgeValue.target === "string" ? edgeValue.target : "";
    const relation = typeof edgeValue.relation === "string" ? edgeValue.relation : "";
    if (!/^gold:edge:\d{3,}$/.test(id)) issues.push(`${location}.id is invalid`);
    if (seenEdgeIds.has(id)) issues.push(`${location}.id is duplicated`);
    seenEdgeIds.add(id);
    if (!nodeTypes.has(source) || !nodeTypes.has(target)) issues.push(`${location} has a dangling endpoint`);
    if (source === target) issues.push(`${location} is a self relation`);
    if (!RELATION_TYPE_SET.has(relation)) issues.push(`${location}.relation is invalid`);
    if (!DISPLAY_RELATION_SET.has(String(edgeValue.displayType))) issues.push(`${location}.displayType is invalid`);
    if (!LAYER_SET.has(String(edgeValue.layer))) issues.push(`${location}.layer is invalid`);
    const confidence = typeof edgeValue.confidence === "number" ? edgeValue.confidence : NaN;
    if (!Number.isFinite(confidence) || confidence > 1 || confidence < 0.7) issues.push(`${location}.confidence is invalid`);
    if (RELATION_TYPE_SET.has(relation)
      && Number.isFinite(confidence)
      && confidence < relationMinimumConfidence[relation as GoldRelationType]) {
      issues.push(`${location}.confidence is below the relation minimum`);
    }
    if (RELATION_TYPE_SET.has(relation) && nodeTypes.has(source) && nodeTypes.has(target)
      && !isAllowedGoldRelationPattern(relation as GoldRelationType, nodeTypes.get(source)!, nodeTypes.get(target)!)) {
      issues.push(`${location} violates the ${relation} source-target pattern`);
    }
    const edgeKey = `${source}|${target}|${relation}`;
    if (seenEdgeKeys.has(edgeKey)) issues.push(`${location} duplicates a semantic relation`);
    seenEdgeKeys.add(edgeKey);
    issues.push(...evidenceIssues(edgeValue.evidence, location, repository));
    if (edgeValue.layer === "inferred" && Array.isArray(edgeValue.evidence)) {
      const uniqueBlocks = new Set(edgeValue.evidence.filter(isRecord).map((item) => item.blockId));
      if (uniqueBlocks.size < 2) issues.push(`${location} inferred relation needs two independent blocks`);
    }
  }

  return issues;
}
