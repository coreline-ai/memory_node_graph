import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditLocalD1Database } from "./lib/local-d1-baseline.mjs";
import { resolveLocalD1Database } from "./lib/local-d1.mjs";
import {
  buildPublicGraphArtifact,
  PUBLIC_GRAPH_SOURCE_SCHEMA,
  sha256Text,
  stableJson,
  verifyPublicGraphArtifacts,
} from "./lib/public-graph-artifact.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const option = (name) => process.argv.slice(2)
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const databasePath = await resolveLocalD1Database({ root, requested: option("--db") });
const policyPath = resolve(root, option("--policy") ?? "config/public-graph-sources.json");
const outputDirectory = resolve(root, option("--output") ?? "public/atlas");

const policyText = await readFile(policyPath, "utf8");
const policy = JSON.parse(policyText);
if (policy.schemaVersion !== PUBLIC_GRAPH_SOURCE_SCHEMA || !Array.isArray(policy.repositories)) {
  throw new Error("공개 source 정책 파일 형식이 올바르지 않습니다.");
}
const publicRepositoryKeys = new Set();
for (const repository of policy.repositories) {
  const key = String(repository.nameWithOwner ?? "").trim().toLowerCase();
  const url = String(repository.url ?? "").trim();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(key)) {
    throw new Error(`공개 저장소 이름 형식이 올바르지 않습니다: ${key}`);
  }
  if (url.toLowerCase() !== `https://github.com/${key}`) {
    throw new Error(`공개 저장소 URL이 nameWithOwner와 일치하지 않습니다: ${url}`);
  }
  if (publicRepositoryKeys.has(key)) throw new Error(`공개 저장소가 중복되었습니다: ${key}`);
  publicRepositoryKeys.add(key);
}
if (!publicRepositoryKeys.size) throw new Error("공개 저장소 allowlist가 비어 있습니다.");

const database = new DatabaseSync(databasePath);
database.exec("PRAGMA query_only = ON");
const audit = auditLocalD1Database(databasePath);
if (audit.integrityCheck !== "ok") throw new Error(`D1 integrity_check 실패: ${audit.integrityCheck}`);
const orphanCount = Object.values(audit.integrity)
  .reduce((sum, value) => sum + Number(value), 0);
if (orphanCount !== 0) throw new Error(`D1 정합성 오류가 있어 공개 export를 중단합니다: ${orphanCount}`);

const documentRows = database.prepare(`SELECT id, source_type, repository_owner,
    repository_name, status, updated_at
  FROM documents ORDER BY id`).all();
const publicDocuments = documentRows.filter((document) => {
  if (document.status !== "completed" && document.status !== "unchanged") return false;
  if (document.source_type !== "github") return false;
  return publicRepositoryKeys.has(
    `${String(document.repository_owner)}/${String(document.repository_name)}`.toLowerCase(),
  );
});
const publicDocumentIds = new Set(publicDocuments.map((document) => String(document.id)));
if (!publicDocumentIds.size) throw new Error("공개 allowlist와 일치하는 완료 문서가 없습니다.");
const publicRepositoriesInD1 = new Set(publicDocuments.map((document) =>
  `${String(document.repository_owner)}/${String(document.repository_name)}`.toLowerCase()));

const provenanceByEntityId = new Map();
for (const mention of database.prepare("SELECT document_id, entity_id FROM entity_mentions ORDER BY entity_id").iterate()) {
  const entityId = String(mention.entity_id);
  const provenance = provenanceByEntityId.get(entityId) ?? { public: false, other: false };
  if (publicDocumentIds.has(String(mention.document_id))) provenance.public = true;
  else provenance.other = true;
  provenanceByEntityId.set(entityId, provenance);
}
const safeEntityIds = new Set();
let excludedMixedProvenanceNodes = 0;
for (const [entityId, provenance] of provenanceByEntityId) {
  if (provenance.public && !provenance.other) safeEntityIds.add(entityId);
  else if (provenance.public && provenance.other) excludedMixedProvenanceNodes += 1;
}

const nodes = database.prepare("SELECT * FROM entities ORDER BY id").all()
  .filter((row) => safeEntityIds.has(String(row.id)))
  .map((row) => ({
    id: String(row.id),
    label: String(row.label),
    shortLabel: String(row.short_label),
    kind: String(row.kind),
    domain: String(row.domain),
    summary: String(row.summary),
    insight: String(row.insight),
    tags: JSON.parse(String(row.tags_json)),
  }));
const edges = database.prepare(`SELECT document_id, source_id, target_id, type,
    confidence, note, origin FROM relations ORDER BY source_id, target_id, type`).all()
  .filter((row) => publicDocumentIds.has(String(row.document_id))
    && safeEntityIds.has(String(row.source_id))
    && safeEntityIds.has(String(row.target_id)))
  .map((row) => ({
    source: String(row.source_id),
    target: String(row.target_id),
    type: String(row.type),
    confidence: Number(row.confidence),
    note: String(row.note),
    layer: row.origin === "codex"
      ? "inferred"
      : ["documents", "plans", "contains"].includes(String(row.type))
        ? "structural"
        : "explicit",
    origin: row.origin === "codex" ? "codex" : "rule",
  }));
if (!nodes.length || !edges.length) throw new Error("공개 corpus 후보가 비어 있습니다.");

const latestPublicDocumentAt = publicDocuments
  .map((document) => String(document.updated_at ?? ""))
  .sort((left, right) => right.localeCompare(left))[0];
const publicRevision = `public-source-${audit.dataFingerprint.slice(0, 24)}`;
const sourceSnapshot = {
  nodes,
  edges,
  meta: {
    source: "documents",
    provider: "markdown-ast",
    generatedAt: latestPublicDocumentAt,
    documentCount: publicDocuments.length,
    repositoryCount: publicRepositoriesInD1.size,
    corpusNodeCount: nodes.length,
    corpusEdgeCount: edges.length,
    graphRevision: publicRevision,
  },
};

let projectGraphCorpus;
let analyzeGraphSnapshot;
try {
  ({ projectGraphCorpus } = await import(new URL(
    "../.runtime-dist/app/lib/graph/scope-projection.js",
    import.meta.url,
  ).href));
  ({ analyzeGraphSnapshot } = await import(new URL(
    "../.runtime-dist/app/lib/graph/analytics.js",
    import.meta.url,
  ).href));
} catch {
  throw new Error("공개 export 모듈이 없습니다. 먼저 `npm run runtime:build`를 실행하세요.");
}
const projection = analyzeGraphSnapshot(projectGraphCorpus(sourceSnapshot));
const policySha256 = sha256Text(stableJson(policy));
const artifacts = buildPublicGraphArtifact(projection, {
  generatedAt: latestPublicDocumentAt,
  dataFingerprint: audit.dataFingerprint,
  policySha256,
  policyRepositoryCount: publicRepositoryKeys.size,
  publicRepositoryCount: publicRepositoriesInD1.size,
  publicDocumentCount: publicDocuments.length,
  publicCorpusNodeCount: nodes.length,
  publicCorpusEdgeCount: edges.length,
  excludedMixedProvenanceNodes,
});
verifyPublicGraphArtifacts(artifacts);
const lowerSnapshotText = artifacts.snapshotText.toLowerCase();
const excludedRepositoryNames = [...new Set(documentRows
  .filter((document) => document.source_type === "github")
  .filter((document) => !publicRepositoryKeys.has(
    `${String(document.repository_owner)}/${String(document.repository_name)}`.toLowerCase(),
  ))
  .map((document) => String(document.repository_name).trim())
  .filter((name) => name.length >= 5))];
const leakedRepositoryNames = excludedRepositoryNames
  .filter((name) => lowerSnapshotText.includes(name.toLowerCase()));
if (leakedRepositoryNames.length) {
  throw new Error(`비공개/미허용 저장소 이름이 공개 snapshot에 남았습니다: ${leakedRepositoryNames.join(", ")}`);
}

const writeAtomicIfChanged = async (path, contents) => {
  try {
    if (await readFile(path, "utf8") === contents) return false;
  } catch {
    // The first export creates the artifact.
  }
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, path);
  return true;
};

try {
  const writes = await Promise.all([
    writeAtomicIfChanged(join(outputDirectory, "atlas-graph-snapshot.json"), artifacts.snapshotText),
    writeAtomicIfChanged(join(outputDirectory, "atlas-graph-manifest.json"), artifacts.manifestText),
    writeAtomicIfChanged(join(outputDirectory, "atlas-graph-snapshot.sha256"), artifacts.checksumText),
  ]);
  console.log(JSON.stringify({
    mode: writes.some(Boolean) ? "updated" : "unchanged",
    outputDirectory,
    policyRepositories: publicRepositoryKeys.size,
    publicRepositories: publicRepositoriesInD1.size,
    publicDocuments: publicDocuments.length,
    publicCorpusNodes: nodes.length,
    publicCorpusEdges: edges.length,
    excludedMixedProvenanceNodes,
    projectedNodes: artifacts.snapshot.nodes.length,
    projectedFactualEdges: artifacts.snapshot.meta.projectedFactualEdgeCount,
    displayEdges: artifacts.snapshot.meta.displayEdgeCount,
    projectedLines: artifacts.snapshot.edges.length,
    snapshotSha256: artifacts.snapshotSha256,
    dataFingerprint: audit.dataFingerprint,
  }, null, 2));
} finally {
  database.close();
}
