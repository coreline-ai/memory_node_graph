import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPublicGraphArtifact,
  PUBLIC_GRAPH_SOURCE_SCHEMA,
  verifyPublicGraphArtifacts,
} from "../scripts/lib/public-graph-artifact.mjs";

const node = (id, label, kind = "concept") => ({
  id,
  label,
  shortLabel: label,
  kind,
  domain: "memory",
  summary: `${label} summary`,
  insight: `${label} insight`,
  tags: ["public", "graph"],
  metrics: {
    communityId: "community-01",
    centrality: 0.5,
    degree: 1,
    bridge: false,
  },
});

const context = {
  generatedAt: "2026-08-10T00:00:00.000Z",
  dataFingerprint: "a".repeat(64),
  policySha256: "b".repeat(64),
  policyRepositoryCount: 2,
  publicRepositoryCount: 2,
  publicDocumentCount: 3,
  publicCorpusNodeCount: 2,
  publicCorpusEdgeCount: 1,
  excludedMixedProvenanceNodes: 1,
};

const projection = () => ({
  nodes: [node("repository:github:123", "atlas", "system"), node("concept:private-internal-id", "Memory")],
  edges: [{
    source: "repository:github:123",
    target: "concept:private-internal-id",
    type: "uses",
    confidence: 0.88,
    note: "공개 README에서 확인한 관계입니다.",
    layer: "explicit",
    origin: "rule",
    evidence: [{ blockId: "private-block", sourceUrl: "https://github.com/example/private" }],
  }],
  meta: {
    source: "documents",
    provider: "markdown-ast",
    generatedAt: context.generatedAt,
    analytics: {
      algorithm: "deterministic-test",
      communityCount: 1,
      componentCount: 1,
      density: 1,
      leafRatio: 1,
      nonStructuralRatio: 1,
      inferredEvidenceCoverage: 0,
      communities: [{
        id: "community-01",
        label: "Memory",
        size: 2,
        representativeNodeId: "concept:private-internal-id",
      }],
    },
  },
});

test("공개 artifact는 내부 ID와 relation evidence를 제거하고 참조 정합성을 유지한다", () => {
  const artifact = buildPublicGraphArtifact(projection(), context);
  const result = verifyPublicGraphArtifacts(artifact);

  assert.equal(result.nodes, 2);
  assert.equal(result.factualEdges, 1);
  assert.equal(result.displayEdges, 0);
  assert.doesNotMatch(artifact.snapshotText, /private-internal-id|private-block|sourceUrl/);
  assert.match(artifact.snapshot.nodes[0].id, /^pub_[a-f0-9]{24}$/);
  assert.equal(
    artifact.snapshot.meta.analytics.communities[0].representativeNodeId,
    artifact.snapshot.nodes.find((item) => item.shortLabel === "Memory").id,
  );
});

test("공개 artifact는 로컬 절대경로를 제거한다", () => {
  const input = projection();
  input.nodes[0].summary = "실행 경로 /Users/example/private/project 입니다.";
  const artifact = buildPublicGraphArtifact(input, context);
  assert.match(artifact.snapshot.nodes[0].summary, /\[local-path\]/);
  assert.doesNotMatch(artifact.snapshotText, /\/Users\//);
});

test("공개 artifact는 비밀 패턴과 checksum 변조를 거부한다", () => {
  const secretInput = projection();
  secretInput.nodes[0].insight = `token gho_${"a".repeat(30)}`;
  assert.throws(() => buildPublicGraphArtifact(secretInput, context), /GitHub token/);

  const artifact = buildPublicGraphArtifact(projection(), context);
  assert.throws(() => verifyPublicGraphArtifacts({
    ...artifact,
    checksumText: `${"0".repeat(64)}  atlas-graph-snapshot.json\n`,
  }), /checksum 파일 불일치/);
});

test("공개 source 정책은 GitHub 공개 저장소의 중복 없는 명시 목록이다", async () => {
  const policy = JSON.parse(await readFile(
    new URL("../config/public-graph-sources.json", import.meta.url),
    "utf8",
  ));
  assert.equal(policy.schemaVersion, PUBLIC_GRAPH_SOURCE_SCHEMA);
  assert.ok(policy.repositories.length > 0);
  const keys = policy.repositories.map((item) => item.nameWithOwner.toLowerCase());
  assert.equal(new Set(keys).size, keys.length);
  for (const [index, repository] of policy.repositories.entries()) {
    assert.equal(repository.url.toLowerCase(), `https://github.com/${keys[index]}`);
  }
});
