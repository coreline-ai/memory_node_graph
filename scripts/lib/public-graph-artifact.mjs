import { createHash } from "node:crypto";

export const PUBLIC_GRAPH_SCHEMA = "atlas-public-graph/v1";
export const PUBLIC_GRAPH_MANIFEST_SCHEMA = "atlas-public-graph-manifest/v1";
export const PUBLIC_GRAPH_SOURCE_SCHEMA = "atlas-public-graph-sources/v1";
export const PUBLIC_GRAPH_NODE_LIMIT = 500;
export const PUBLIC_GRAPH_EDGE_LIMIT = 2_000;

const NODE_KINDS = new Set(["thesis", "concept", "system", "tool", "practice", "risk"]);
const DOMAINS = new Set(["reasoning", "agents", "memory", "safety", "product", "infrastructure"]);
const RELATION_TYPES = new Set([
  "documents", "plans", "contains", "implements", "depends_on", "calls",
  "reads_from", "writes_to", "produces", "tests", "references", "precedes",
  "blocks", "supersedes", "same_as", "mentions", "related_to", "supports",
  "extends", "requires", "uses", "mitigates", "risks", "contradicts",
]);
const RELATION_LAYERS = new Set(["structural", "explicit", "inferred", "display"]);
const RELATION_ORIGINS = new Set(["rule", "codex", "display"]);
const FORBIDDEN_KEYS = new Set([
  "sourceUrl", "repositoryId", "repositoryOwner", "repositoryName", "relativePath",
  "commitSha", "documentId", "documentName", "documentSourceLabel",
  "documentSeedNodeIds", "evidence", "providerVersion", "promptVersion",
]);
const SENSITIVE_PATTERNS = [
  { name: "GitHub token", pattern: /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "macOS user path", pattern: /\/(?:Users|Volumes)\/[^\s"']+/ },
  { name: "temporary user path", pattern: /\/private\/var\/folders\/[^\s"']+/ },
  { name: "Windows user path", pattern: /[A-Za-z]:\\Users\\[^\s"']+/ },
];

export const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableValue(item)]));
};

export const stableJson = (value) => `${JSON.stringify(stableValue(value), null, 2)}\n`;

const boundedText = (value, limit, fallback = "") => {
  const normalized = String(value ?? fallback)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\/(?:Users|Volumes)\/[^\s"'`]+/g, "[local-path]")
    .replace(/\/private\/var\/folders\/[^\s"'`]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\Users\\[^\s"'`]+/g, "[local-path]")
    .trim();
  return normalized.slice(0, limit);
};

const publicNodeId = (internalId) =>
  `pub_${sha256Text(`atlas-public-node-v1\0${internalId}`).slice(0, 24)}`;

const finiteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const publicAnalytics = (analytics, publicIdByInternalId) => {
  if (!analytics || typeof analytics !== "object") return undefined;
  return {
    algorithm: boundedText(analytics.algorithm, 120, "unknown"),
    communityCount: Math.max(0, Math.floor(finiteNumber(analytics.communityCount))),
    componentCount: Math.max(0, Math.floor(finiteNumber(analytics.componentCount))),
    density: finiteNumber(analytics.density),
    leafRatio: finiteNumber(analytics.leafRatio),
    nonStructuralRatio: finiteNumber(analytics.nonStructuralRatio),
    inferredEvidenceCoverage: finiteNumber(analytics.inferredEvidenceCoverage),
    communities: Array.isArray(analytics.communities)
      ? analytics.communities.flatMap((community) => {
        const representativeNodeId = publicIdByInternalId.get(String(community.representativeNodeId ?? ""));
        if (!representativeNodeId) return [];
        return [{
          id: boundedText(community.id, 80, "community"),
          label: boundedText(community.label, 180, "Community"),
          size: Math.max(0, Math.floor(finiteNumber(community.size))),
          representativeNodeId,
        }];
      })
      : [],
  };
};

export function buildPublicGraphArtifact(projection, context) {
  if (!projection || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges)) {
    throw new Error("공개 GraphSnapshot 입력 형식이 올바르지 않습니다.");
  }
  if (projection.nodes.length < 1 || projection.nodes.length > PUBLIC_GRAPH_NODE_LIMIT) {
    throw new Error(`공개 node 수가 허용 범위를 벗어났습니다: ${projection.nodes.length}`);
  }
  if (projection.edges.length > PUBLIC_GRAPH_EDGE_LIMIT) {
    throw new Error(`공개 edge 수가 허용 범위를 벗어났습니다: ${projection.edges.length}`);
  }

  const publicIdByInternalId = new Map(projection.nodes.map((node) => [
    String(node.id),
    publicNodeId(String(node.id)),
  ]));
  const nodes = projection.nodes.map((node) => ({
    id: publicIdByInternalId.get(String(node.id)),
    label: boundedText(node.label, 320, "Untitled"),
    shortLabel: boundedText(node.shortLabel, 180, "Untitled"),
    kind: NODE_KINDS.has(node.kind) ? node.kind : "concept",
    domain: DOMAINS.has(node.domain) ? node.domain : "reasoning",
    summary: boundedText(node.summary, 1_200, "공개 문서에서 추출한 지식 노드입니다."),
    insight: boundedText(node.insight, 1_600, "공개 문서의 관계를 통해 탐색할 수 있습니다."),
    tags: [...new Set((Array.isArray(node.tags) ? node.tags : [])
      .map((tag) => boundedText(tag, 100))
      .filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 24),
    metrics: node.metrics ? {
      communityId: boundedText(node.metrics.communityId, 80, "community-00"),
      centrality: finiteNumber(node.metrics.centrality),
      degree: Math.max(0, Math.floor(finiteNumber(node.metrics.degree))),
      bridge: Boolean(node.metrics.bridge),
    } : undefined,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edgeKeys = new Set();
  const edges = projection.edges.map((edge) => {
    const source = publicIdByInternalId.get(String(edge.source));
    const target = publicIdByInternalId.get(String(edge.target));
    if (!source || !target) throw new Error("공개 edge endpoint에 대응하는 node가 없습니다.");
    const type = RELATION_TYPES.has(edge.type) ? edge.type : "related_to";
    const layer = RELATION_LAYERS.has(edge.layer) ? edge.layer : "explicit";
    const origin = RELATION_ORIGINS.has(edge.origin)
      ? edge.origin
      : layer === "display" ? "display" : "rule";
    const key = `${source}|${target}|${type}`;
    if (edgeKeys.has(key)) throw new Error(`공개 edge가 중복되었습니다: ${key}`);
    edgeKeys.add(key);
    return {
      source,
      target,
      type,
      confidence: Math.max(0, Math.min(1, finiteNumber(edge.confidence))),
      note: boundedText(
        edge.note,
        600,
        layer === "display"
          ? "화면 밀도를 위한 비저장 연결선입니다."
          : "공개 문서에서 추출한 관계입니다.",
      ),
      layer,
      origin,
    };
  });
  if (edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    throw new Error("공개 snapshot에 orphan edge가 있습니다.");
  }

  const factualEdgeCount = edges.filter((edge) => edge.layer !== "display").length;
  const displayEdgeCount = edges.length - factualEdgeCount;
  const generatedAt = boundedText(context.generatedAt ?? projection.meta?.generatedAt, 64);
  const snapshot = {
    schemaVersion: PUBLIC_GRAPH_SCHEMA,
    nodes,
    edges,
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt,
      scope: "corpus",
      projectionMode: "full-corpus-knowledge-map",
      documentCount: Math.max(0, Math.floor(finiteNumber(context.publicDocumentCount))),
      repositoryCount: Math.max(0, Math.floor(finiteNumber(context.publicRepositoryCount))),
      nodeBudget: PUBLIC_GRAPH_NODE_LIMIT,
      edgeBudget: PUBLIC_GRAPH_EDGE_LIMIT,
      totalNodeCount: Math.max(nodes.length, Math.floor(finiteNumber(context.publicCorpusNodeCount, nodes.length))),
      omittedNodeCount: Math.max(0, Math.floor(finiteNumber(context.publicCorpusNodeCount, nodes.length)) - nodes.length),
      totalEdgeCount: Math.max(factualEdgeCount, Math.floor(finiteNumber(context.publicCorpusEdgeCount, factualEdgeCount))),
      omittedEdgeCount: Math.max(0, Math.floor(finiteNumber(context.publicCorpusEdgeCount, factualEdgeCount)) - factualEdgeCount),
      projectedFactualEdgeCount: factualEdgeCount,
      displayEdgeCount,
      corpusNodeCount: Math.max(nodes.length, Math.floor(finiteNumber(context.publicCorpusNodeCount, nodes.length))),
      corpusEdgeCount: Math.max(factualEdgeCount, Math.floor(finiteNumber(context.publicCorpusEdgeCount, factualEdgeCount))),
      graphRevision: `public-${String(context.dataFingerprint).slice(0, 32)}-${String(context.policySha256).slice(0, 16)}`,
      publicSnapshot: true,
      analytics: publicAnalytics(projection.meta?.analytics, publicIdByInternalId),
      message: `공개 검증된 ${Math.max(0, Math.floor(finiteNumber(context.publicRepositoryCount)))}개 저장소에서 핵심 노드 ${nodes.length}개, 실제 관계 ${factualEdgeCount}개, 화면용 연결선 ${displayEdgeCount}개를 투영했습니다.`,
    },
  };
  const snapshotText = stableJson(snapshot);
  const snapshotSha256 = sha256Text(snapshotText);
  const manifest = {
    schemaVersion: PUBLIC_GRAPH_MANIFEST_SCHEMA,
    generatedAt,
    snapshotPath: "/atlas/atlas-graph-snapshot.json",
    snapshotSha256,
    source: {
      kind: "local-d1-public-projection",
      dataFingerprint: String(context.dataFingerprint),
      policySha256: String(context.policySha256),
      sourcePolicySchema: PUBLIC_GRAPH_SOURCE_SCHEMA,
    },
    counts: {
      policyRepositories: Math.max(0, Math.floor(finiteNumber(context.policyRepositoryCount))),
      publicRepositories: Math.max(0, Math.floor(finiteNumber(context.publicRepositoryCount))),
      publicDocuments: Math.max(0, Math.floor(finiteNumber(context.publicDocumentCount))),
      publicCorpusNodes: Math.max(nodes.length, Math.floor(finiteNumber(context.publicCorpusNodeCount, nodes.length))),
      publicCorpusEdges: Math.max(factualEdgeCount, Math.floor(finiteNumber(context.publicCorpusEdgeCount, factualEdgeCount))),
      projectedNodes: nodes.length,
      projectedFactualEdges: factualEdgeCount,
      displayEdges: displayEdgeCount,
      projectedLines: edges.length,
      excludedMixedProvenanceNodes: Math.max(0, Math.floor(finiteNumber(context.excludedMixedProvenanceNodes))),
    },
    privacy: {
      policy: "explicit-public-repository-allowlist-and-exclusive-provenance",
      internalNodeIds: "sha256-pseudonymized",
      relationEvidence: "omitted",
      localPaths: "redacted-and-rejected",
      secrets: "pattern-rejected",
      d1Database: "not-included",
      oauth: "not-included",
    },
  };
  const manifestText = stableJson(manifest);
  assertNoSensitiveContent(snapshotText);
  assertNoSensitiveContent(manifestText);
  return {
    snapshot,
    snapshotText,
    snapshotSha256,
    manifest,
    manifestText,
    checksumText: `${snapshotSha256}  atlas-graph-snapshot.json\n`,
  };
}

export function assertNoSensitiveContent(value) {
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) throw new Error(`공개 artifact에서 금지된 ${name} 패턴을 발견했습니다.`);
  }
}

const collectForbiddenKeys = (value, path = "$", findings = []) => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenKeys(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (!value || typeof value !== "object") return findings;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) findings.push(`${path}.${key}`);
    collectForbiddenKeys(item, `${path}.${key}`, findings);
  }
  return findings;
};

export function verifyPublicGraphArtifacts({ snapshotText, manifestText, checksumText }) {
  assertNoSensitiveContent(snapshotText);
  assertNoSensitiveContent(manifestText);
  const snapshot = JSON.parse(snapshotText);
  const manifest = JSON.parse(manifestText);
  const errors = [];
  if (snapshot.schemaVersion !== PUBLIC_GRAPH_SCHEMA) errors.push("snapshot schemaVersion 불일치");
  if (manifest.schemaVersion !== PUBLIC_GRAPH_MANIFEST_SCHEMA) errors.push("manifest schemaVersion 불일치");
  if (!Array.isArray(snapshot.nodes) || snapshot.nodes.length < 1 || snapshot.nodes.length > PUBLIC_GRAPH_NODE_LIMIT) {
    errors.push("snapshot node 예산 위반");
  }
  if (!Array.isArray(snapshot.edges) || snapshot.edges.length > PUBLIC_GRAPH_EDGE_LIMIT) {
    errors.push("snapshot edge 예산 위반");
  }
  const nodeIds = new Set();
  for (const node of snapshot.nodes ?? []) {
    if (!/^pub_[a-f0-9]{24}$/.test(String(node.id))) errors.push(`공개 node ID 형식 오류: ${node.id}`);
    if (nodeIds.has(node.id)) errors.push(`중복 node ID: ${node.id}`);
    nodeIds.add(node.id);
    if (!NODE_KINDS.has(node.kind)) errors.push(`node kind 오류: ${node.kind}`);
    if (!DOMAINS.has(node.domain)) errors.push(`node domain 오류: ${node.domain}`);
  }
  const edgeKeys = new Set();
  for (const edge of snapshot.edges ?? []) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) errors.push("orphan edge");
    if (!RELATION_TYPES.has(edge.type)) errors.push(`edge type 오류: ${edge.type}`);
    if (!RELATION_LAYERS.has(edge.layer)) errors.push(`edge layer 오류: ${edge.layer}`);
    if (!RELATION_ORIGINS.has(edge.origin)) errors.push(`edge origin 오류: ${edge.origin}`);
    const key = `${edge.source}|${edge.target}|${edge.type}`;
    if (edgeKeys.has(key)) errors.push(`중복 edge: ${key}`);
    edgeKeys.add(key);
  }
  const factualEdges = (snapshot.edges ?? []).filter((edge) => edge.layer !== "display").length;
  const displayEdges = (snapshot.edges ?? []).length - factualEdges;
  if (snapshot.meta?.projectedFactualEdgeCount !== factualEdges) errors.push("factual edge meta 불일치");
  if (snapshot.meta?.displayEdgeCount !== displayEdges) errors.push("display edge meta 불일치");
  if (manifest.counts?.projectedNodes !== snapshot.nodes?.length) errors.push("manifest node 수 불일치");
  if (manifest.counts?.projectedFactualEdges !== factualEdges) errors.push("manifest factual edge 수 불일치");
  if (manifest.counts?.displayEdges !== displayEdges) errors.push("manifest display edge 수 불일치");
  if (manifest.counts?.projectedLines !== snapshot.edges?.length) errors.push("manifest 전체 선 수 불일치");
  const snapshotSha256 = sha256Text(snapshotText);
  if (manifest.snapshotSha256 !== snapshotSha256) errors.push("snapshot SHA-256 불일치");
  if (checksumText.trim() !== `${snapshotSha256}  atlas-graph-snapshot.json`) errors.push("checksum 파일 불일치");
  const forbiddenKeys = collectForbiddenKeys(snapshot);
  if (forbiddenKeys.length) errors.push(`금지 필드 포함: ${forbiddenKeys.slice(0, 8).join(", ")}`);
  if (errors.length) throw new Error(`공개 그래프 artifact 검증 실패: ${errors.join("; ")}`);
  return {
    snapshotSha256,
    nodes: snapshot.nodes.length,
    factualEdges,
    displayEdges,
    lines: snapshot.edges.length,
    publicRepositories: manifest.counts.publicRepositories,
    publicDocuments: manifest.counts.publicDocuments,
  };
}
