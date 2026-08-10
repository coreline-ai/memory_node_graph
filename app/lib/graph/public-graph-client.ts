import type {
  Domain,
  KnowledgeEdge,
  KnowledgeNode,
  NodeKind,
  RelationKind,
  RelationLayer,
} from "../../graph-data";
import type { GraphSnapshot } from "./model";

export const PUBLIC_GRAPH_SCHEMA = "atlas-public-graph/v1";
export const PUBLIC_GRAPH_MANIFEST_SCHEMA = "atlas-public-graph-manifest/v1";
export const PUBLIC_FIXTURE_GRAPH_SCHEMA = "atlas-public-fixture-graph/v1";
export const PUBLIC_GRAPH_SNAPSHOT_PATH = "/atlas/atlas-graph-snapshot.json";
export const PUBLIC_GRAPH_MANIFEST_PATH = "/atlas/atlas-graph-manifest.json";
export const PUBLIC_GOLD_SNAPSHOT_PATH = "/atlas/atlas-gold-snapshot.json";
export const PUBLIC_GOLD_CHECKSUM_PATH = "/atlas/atlas-gold-snapshot.sha256";

const NODE_LIMIT = 500;
const EDGE_LIMIT = 2_000;
const NODE_KINDS = new Set<NodeKind>(["thesis", "concept", "system", "tool", "practice", "risk"]);
const DOMAINS = new Set<Domain>(["reasoning", "agents", "memory", "safety", "product", "infrastructure"]);
const RELATION_TYPES = new Set<RelationKind>([
  "documents", "plans", "contains", "implements", "depends_on", "calls",
  "reads_from", "writes_to", "produces", "tests", "references", "precedes",
  "blocks", "supersedes", "same_as", "mentions", "related_to", "supports",
  "extends", "requires", "uses", "mitigates", "risks", "contradicts",
]);
const RELATION_LAYERS = new Set<RelationLayer>(["structural", "explicit", "inferred", "display"]);
const RELATION_ORIGINS = new Set(["rule", "codex", "display"]);

type PublicGraphManifest = {
  schemaVersion: typeof PUBLIC_GRAPH_MANIFEST_SCHEMA;
  snapshotPath: typeof PUBLIC_GRAPH_SNAPSHOT_PATH;
  snapshotSha256: string;
  counts: {
    projectedNodes: number;
    projectedFactualEdges: number;
    displayEdges: number;
    projectedLines: number;
  };
};

type PublicGraphFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text">>;

export type PublicGraphLoadResult = {
  snapshot: GraphSnapshot;
  manifest: PublicGraphManifest;
  snapshotSha256: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const integerBetween = (value: unknown, minimum: number, maximum: number) =>
  Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;

const parseJson = (text: string, label: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} JSON 형식이 올바르지 않습니다.`);
  }
};

const sha256Text = async (value: string) => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const validateManifest = (value: unknown): PublicGraphManifest => {
  if (!isRecord(value) || value.schemaVersion !== PUBLIC_GRAPH_MANIFEST_SCHEMA) {
    throw new Error("공개 그래프 manifest 버전이 올바르지 않습니다.");
  }
  if (value.snapshotPath !== PUBLIC_GRAPH_SNAPSHOT_PATH) {
    throw new Error("공개 그래프 snapshot 경로가 허용된 경로와 다릅니다.");
  }
  if (typeof value.snapshotSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotSha256)) {
    throw new Error("공개 그래프 SHA-256 형식이 올바르지 않습니다.");
  }
  if (!isRecord(value.counts)) {
    throw new Error("공개 그래프 manifest 수량 정보가 없습니다.");
  }
  const counts = value.counts;
  if (
    !integerBetween(counts.projectedNodes, 1, NODE_LIMIT)
    || !integerBetween(counts.projectedFactualEdges, 0, EDGE_LIMIT)
    || !integerBetween(counts.displayEdges, 0, EDGE_LIMIT)
    || !integerBetween(counts.projectedLines, 0, EDGE_LIMIT)
  ) {
    throw new Error("공개 그래프 manifest 수량이 허용 범위를 벗어났습니다.");
  }
  return value as PublicGraphManifest;
};

const validateNode = (
  value: unknown,
  idPattern = /^pub_[a-f0-9]{24}$/,
): value is KnowledgeNode => {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && idPattern.test(value.id)
    && typeof value.label === "string"
    && typeof value.shortLabel === "string"
    && NODE_KINDS.has(value.kind as NodeKind)
    && DOMAINS.has(value.domain as Domain)
    && typeof value.summary === "string"
    && typeof value.insight === "string"
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === "string");
};

const validateEdge = (value: unknown): value is KnowledgeEdge => {
  if (!isRecord(value)) return false;
  return typeof value.source === "string"
    && typeof value.target === "string"
    && RELATION_TYPES.has(value.type as RelationKind)
    && isFiniteNumber(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
    && typeof value.note === "string"
    && RELATION_LAYERS.has(value.layer as RelationLayer)
    && RELATION_ORIGINS.has(value.origin as string);
};

export function validatePublicGraphSnapshot(value: unknown): GraphSnapshot {
  if (!isRecord(value) || value.schemaVersion !== PUBLIC_GRAPH_SCHEMA) {
    throw new Error("공개 그래프 snapshot 버전이 올바르지 않습니다.");
  }
  if (!Array.isArray(value.nodes) || !integerBetween(value.nodes.length, 1, NODE_LIMIT)) {
    throw new Error("공개 그래프 node 수가 허용 범위를 벗어났습니다.");
  }
  if (!Array.isArray(value.edges) || !integerBetween(value.edges.length, 0, EDGE_LIMIT)) {
    throw new Error("공개 그래프 edge 수가 허용 범위를 벗어났습니다.");
  }
  if (!value.nodes.every((node) => validateNode(node)) || !value.edges.every(validateEdge)) {
    throw new Error("공개 그래프 node 또는 edge 형식이 올바르지 않습니다.");
  }
  if (!isRecord(value.meta)
    || value.meta.publicSnapshot !== true
    || value.meta.source !== "documents"
    || value.meta.provider !== "markdown-ast"
    || value.meta.scope !== "corpus") {
    throw new Error("공개 그래프 meta 계약이 올바르지 않습니다.");
  }

  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (nodeIds.has(node.id)) throw new Error(`공개 그래프 node ID가 중복되었습니다: ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  let factualEdges = 0;
  let displayEdges = 0;
  for (const edge of value.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error("공개 그래프에 연결 대상이 없는 edge가 있습니다.");
    }
    const edgeId = `${edge.source}|${edge.target}|${edge.type}`;
    if (edgeIds.has(edgeId)) throw new Error(`공개 그래프 edge가 중복되었습니다: ${edgeId}`);
    edgeIds.add(edgeId);
    if (edge.layer === "display") displayEdges += 1;
    else factualEdges += 1;
  }
  if (value.meta.projectedFactualEdgeCount !== factualEdges
    || value.meta.displayEdgeCount !== displayEdges) {
    throw new Error("공개 그래프 실제 관계와 화면용 연결선 수가 meta와 다릅니다.");
  }
  return value as unknown as GraphSnapshot;
}

export function validatePublicGoldGraphSnapshot(value: unknown): GraphSnapshot {
  if (!isRecord(value) || value.schemaVersion !== PUBLIC_FIXTURE_GRAPH_SCHEMA) {
    throw new Error("공개 Gold Graph snapshot 버전이 올바르지 않습니다.");
  }
  if (!Array.isArray(value.nodes) || !integerBetween(value.nodes.length, 1, NODE_LIMIT)) {
    throw new Error("공개 Gold Graph node 수가 허용 범위를 벗어났습니다.");
  }
  if (!Array.isArray(value.edges) || !integerBetween(value.edges.length, 0, EDGE_LIMIT)) {
    throw new Error("공개 Gold Graph edge 수가 허용 범위를 벗어났습니다.");
  }
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (!validateNode(node, /^gold_public_[a-f0-9]{20}$/)) {
      throw new Error("공개 Gold Graph node 형식이 올바르지 않습니다.");
    }
    if (nodeIds.has(node.id)) throw new Error(`공개 Gold Graph node ID가 중복되었습니다: ${node.id}`);
    nodeIds.add(node.id);
  }
  let factualEdges = 0;
  let displayEdges = 0;
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (!validateEdge(edge)) throw new Error("공개 Gold Graph edge 형식이 올바르지 않습니다.");
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error("공개 Gold Graph에 연결 대상이 없는 edge가 있습니다.");
    }
    // Gold의 화면용 type은 여러 온톨로지 relation을 하나의 시각 type으로
    // 축약할 수 있으므로 note까지 포함해야 서로 다른 관계가 충돌하지 않는다.
    const edgeId = `${edge.source}|${edge.target}|${edge.type}|${edge.layer}|${edge.note}`;
    if (edgeIds.has(edgeId)) throw new Error(`공개 Gold Graph edge가 중복되었습니다: ${edgeId}`);
    edgeIds.add(edgeId);
    if (edge.layer === "display") displayEdges += 1;
    else factualEdges += 1;
  }
  if (!isRecord(value.meta)
    || value.meta.source !== "demo"
    || value.meta.provider !== "gold-graph-fixture"
    || value.meta.publicFixture !== true
    || value.meta.projectedFactualEdgeCount !== factualEdges
    || value.meta.displayEdgeCount !== displayEdges) {
    throw new Error("공개 Gold Graph meta 계약이 올바르지 않습니다.");
  }
  return value as unknown as GraphSnapshot;
}

export async function loadPublicGraphSnapshot(
  fetchGraph: PublicGraphFetch = globalThis.fetch,
): Promise<PublicGraphLoadResult> {
  const [snapshotResponse, manifestResponse] = await Promise.all([
    fetchGraph(PUBLIC_GRAPH_SNAPSHOT_PATH, { cache: "no-cache" }),
    fetchGraph(PUBLIC_GRAPH_MANIFEST_PATH, { cache: "no-cache" }),
  ]);
  if (!snapshotResponse.ok) {
    throw new Error(`공개 그래프 snapshot을 불러오지 못했습니다. (${snapshotResponse.status})`);
  }
  if (!manifestResponse.ok) {
    throw new Error(`공개 그래프 manifest를 불러오지 못했습니다. (${manifestResponse.status})`);
  }
  const [snapshotText, manifestText] = await Promise.all([
    snapshotResponse.text(),
    manifestResponse.text(),
  ]);
  const manifest = validateManifest(parseJson(manifestText, "공개 그래프 manifest"));
  const snapshotSha256 = await sha256Text(snapshotText);
  if (snapshotSha256 !== manifest.snapshotSha256) {
    throw new Error("공개 그래프 snapshot SHA-256이 manifest와 다릅니다.");
  }
  const snapshot = validatePublicGraphSnapshot(parseJson(snapshotText, "공개 그래프 snapshot"));
  const factualEdges = snapshot.edges.filter((edge) => edge.layer !== "display").length;
  const displayEdges = snapshot.edges.length - factualEdges;
  if (
    manifest.counts.projectedNodes !== snapshot.nodes.length
    || manifest.counts.projectedFactualEdges !== factualEdges
    || manifest.counts.displayEdges !== displayEdges
    || manifest.counts.projectedLines !== snapshot.edges.length
  ) {
    throw new Error("공개 그래프 snapshot 수량이 manifest와 다릅니다.");
  }
  return { snapshot, manifest, snapshotSha256 };
}

export async function loadPublicGoldGraphSnapshot(
  fetchGraph: PublicGraphFetch = globalThis.fetch,
): Promise<GraphSnapshot> {
  const [snapshotResponse, checksumResponse] = await Promise.all([
    fetchGraph(PUBLIC_GOLD_SNAPSHOT_PATH, { cache: "no-cache" }),
    fetchGraph(PUBLIC_GOLD_CHECKSUM_PATH, { cache: "no-cache" }),
  ]);
  if (!snapshotResponse.ok || !checksumResponse.ok) {
    throw new Error("공개 Gold Graph 파일을 불러오지 못했습니다.");
  }
  const [snapshotText, checksumText] = await Promise.all([
    snapshotResponse.text(),
    checksumResponse.text(),
  ]);
  const snapshotSha256 = await sha256Text(snapshotText);
  if (checksumText.trim() !== `${snapshotSha256}  atlas-gold-snapshot.json`) {
    throw new Error("공개 Gold Graph snapshot SHA-256이 올바르지 않습니다.");
  }
  return validatePublicGoldGraphSnapshot(parseJson(snapshotText, "공개 Gold Graph snapshot"));
}
