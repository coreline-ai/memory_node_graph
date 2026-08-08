import assert from "node:assert/strict";
import test from "node:test";

import {
  attachRepositoryNodeSources,
  parseGitHubNodeSource,
} from "../.runtime-dist/app/lib/graph/source-metadata.js";

const node = (id) => ({
  id,
  label: id,
  shortLabel: id,
  kind: "system",
  domain: "infrastructure",
  summary: id,
  insight: "fixture",
  tags: [],
});

const evidenceEdge = (source, target, sourceUrl) => ({
  source,
  target,
  type: "contains",
  confidence: 0.99,
  note: "evidence",
  evidence: [{ blockId: `block:${source}:${target}`, explanation: "source", sourceUrl }],
});

test("GitHub line evidence를 저장소·경로·커밋 원본 메타데이터로 안전하게 복원한다", () => {
  const sha = "A".repeat(40);
  const sourceUrl = `https://github.com/coreline-ai/memory_node_graph/blob/${sha}/dev-plan/%EA%B5%AC%ED%98%84.md#L12-L18`;
  assert.deepEqual(parseGitHubNodeSource(sourceUrl, "1322252398"), {
    provider: "github",
    repositoryId: "1322252398",
    repositoryOwner: "coreline-ai",
    repositoryName: "memory_node_graph",
    relativePath: "dev-plan/구현.md",
    commitSha: "a".repeat(40),
    sourceUrl,
  });
});

test("GitHub 외 호스트·비 HTTPS·잘못된 commit/path evidence는 원본 링크로 허용하지 않는다", () => {
  const sha = "a".repeat(40);
  const invalid = [
    `http://github.com/coreline-ai/repo/blob/${sha}/README.md#L1`,
    `https://github.com.evil.example/coreline-ai/repo/blob/${sha}/README.md#L1`,
    "https://github.com/coreline-ai/repo/blob/abc/README.md#L1",
    `https://github.com/coreline-ai/repo/blob/${sha}/%2E%2E/secret.md#L1`,
    `https://github.com/coreline-ai/repo/blob/${sha}/README.md?download=1#L1`,
  ];
  assert.ok(invalid.every((sourceUrl) => parseGitHubNodeSource(sourceUrl, "1001") === null));
});

test("노드 원본은 입력 순서와 무관하게 README를 우선하고 양쪽 관계 끝점에 투영한다", () => {
  const sha = "b".repeat(40);
  const repository = node("repository:github:1001");
  const task = node("task:one");
  const planUrl = `https://github.com/coreline-ai/repo/blob/${sha}/dev-plan/implement.md#L20`;
  const readmeUrl = `https://github.com/coreline-ai/repo/blob/${sha}/README.md#L4`;
  const edges = [
    evidenceEdge(repository.id, task.id, planUrl),
    evidenceEdge(repository.id, task.id, readmeUrl),
  ];
  const first = attachRepositoryNodeSources([repository, task], edges, "1001");
  const repeated = attachRepositoryNodeSources([repository, task], [...edges].reverse(), "1001");

  assert.deepEqual(repeated, first);
  assert.ok(first.every((item) => item.source?.relativePath === "README.md"));
  assert.ok(first.every((item) => item.source?.repositoryId === "1001"));
});
