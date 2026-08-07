import assert from "node:assert/strict";
import test from "node:test";

import { projectGitHubRepositorySyncSummaries } from "../.connector-dist/app/lib/github/dashboard-projection.js";

const repository = (repositoryId, name) => ({
  repositoryId,
  owner: "coreline-ai",
  name,
  visibility: "public",
  isPrivate: false,
  isFork: false,
  isArchived: false,
  isTemplate: false,
  defaultBranch: "main",
  updatedAt: "2026-08-04T10:00:00.000Z",
  url: `https://github.com/coreline-ai/${name}`,
});

const input = (kind, repositoryIds, suffix) => ({
  jobId: `github-source:${kind}:${suffix}`,
  idempotencyKey: suffix.repeat(64).slice(0, 64),
  kind,
  owner: "coreline-ai",
  selectedRepositoryIds: repositoryIds,
});

const job = ({
  id,
  kind,
  repositoryIds = [],
  status,
  updatedAt,
  result,
  errorCode,
  errorMessage,
  manualRetryCount = 0,
}) => ({
  id,
  idempotencyKey: id.padEnd(64, "a").slice(0, 64),
  kind,
  owner: "coreline-ai",
  status,
  input: input(kind, repositoryIds, id[0] ?? "a"),
  result,
  attemptCount: status === "queued" ? 0 : 1,
  maxAttempts: 3,
  manualRetryCount,
  errorCode,
  errorMessage,
  createdAt: updatedAt,
  updatedAt,
});

const discoveryResult = {
  jobId: "discovery",
  idempotencyKey: "d".repeat(64),
  kind: "discovery",
  status: "completed",
  capability: { capability: "github-source", status: "online", checkedAt: "2026-08-04T10:00:00.000Z" },
  summary: { discoveredCount: 3, selectedCount: 3, changedCount: 0, unchangedCount: 0, deletedCount: 0, failedCount: 0 },
  discovery: {
    owner: "coreline-ai",
    accountLogin: "coreline-ai",
    repositories: [repository("1", "alpha"), repository("2", "beta"), repository("3", "gamma")],
    selection: {
      items: [],
      selectedRepositoryIds: ["1", "2", "3"],
      unavailableSelectedRepositoryIds: [],
      selectionDigest: "s".repeat(64),
    },
    totals: { total: 3, public: 3, private: 0, internal: 0, fork: 0, archived: 0, template: 0, recommended: 3, selected: 3, warnings: 0 },
    generatedAt: "2026-08-04T10:00:00.000Z",
  },
};

test("저장소별 상태는 저장된 그래프 집계를 보존하면서 최신 Apply 실패·실행 상태를 우선한다", () => {
  const jobs = [
    job({ id: "discovery", kind: "discovery", status: "completed", updatedAt: "2026-08-04T10:00:00.000Z", result: discoveryResult }),
    job({
      id: "apply-failed",
      kind: "apply",
      repositoryIds: ["1"],
      status: "failed",
      updatedAt: "2026-08-04T12:00:00.000Z",
      errorCode: "github_rate_limited",
      errorMessage: "GitHub rate limit 대기 중",
    }),
    job({ id: "apply-running", kind: "apply", repositoryIds: ["2"], status: "running", updatedAt: "2026-08-04T12:01:00.000Z" }),
  ];
  const stored = [{
    repositoryId: "1",
    repositoryOwner: "coreline-ai",
    repositoryName: "alpha",
    documentCount: 7,
    nodeCount: 280,
    edgeCount: 281,
    commitSha: "a".repeat(40),
    lastSyncedAt: "2026-08-04T11:00:00.000Z",
  }];

  const summaries = projectGitHubRepositorySyncSummaries(jobs, stored);
  const byId = new Map(summaries.map((item) => [item.repositoryId, item]));
  assert.equal(byId.get("1").status, "failed");
  assert.equal(byId.get("1").documentCount, 7);
  assert.equal(byId.get("1").lastSyncedAt, "2026-08-04T11:00:00.000Z");
  assert.equal(byId.get("1").errorCode, "github_rate_limited");
  assert.deepEqual(byId.get("1").retry, {
    jobId: "apply-failed",
    manualRetryCount: 0,
    maxManualRetries: 2,
    available: true,
  });
  assert.equal(byId.get("2").status, "syncing");
  assert.equal(byId.get("2").retry, undefined);
  assert.equal(byId.get("3").status, "not_synced");
});

test("실패 Apply의 수동 재시도 한도 소진 여부를 저장소별로 분리한다", () => {
  const summaries = projectGitHubRepositorySyncSummaries([
    job({ id: "discovery", kind: "discovery", status: "completed", updatedAt: "2026-08-04T10:00:00.000Z", result: discoveryResult }),
    job({
      id: "apply-exhausted",
      kind: "apply",
      repositoryIds: ["1"],
      status: "failed",
      updatedAt: "2026-08-04T12:00:00.000Z",
      errorCode: "retry_exhausted",
      errorMessage: "재시도 한도 소진",
      manualRetryCount: 2,
    }),
    job({
      id: "apply-retryable",
      kind: "apply",
      repositoryIds: ["2"],
      status: "failed",
      updatedAt: "2026-08-04T12:01:00.000Z",
      errorCode: "connector_offline",
      errorMessage: "Connector 중단",
      manualRetryCount: 1,
    }),
  ], []);
  const byId = new Map(summaries.map((item) => [item.repositoryId, item]));

  assert.deepEqual(byId.get("1").retry, {
    jobId: "apply-exhausted",
    manualRetryCount: 2,
    maxManualRetries: 2,
    available: false,
  });
  assert.deepEqual(byId.get("2").retry, {
    jobId: "apply-retryable",
    manualRetryCount: 1,
    maxManualRetries: 2,
    available: true,
  });
});

test("최신 완료 영수증은 상태·commit·문서·노드·관계 수를 결정적으로 갱신한다", () => {
  const receipt = {
    repositoryId: "1",
    repositoryName: "alpha-renamed",
    commitSha: "b".repeat(40),
    manifestDigest: "m".repeat(64),
    fileCount: 4,
    createdCount: 1,
    updatedCount: 1,
    unchangedCount: 2,
    deletedCount: 0,
    nodeCount: 120,
    edgeCount: 140,
    appliedAt: "2026-08-04T13:00:00.000Z",
  };
  const completed = job({
    id: "apply-completed",
    kind: "apply",
    repositoryIds: ["1"],
    status: "completed",
    updatedAt: "2026-08-04T13:00:00.000Z",
    result: {
      jobId: "apply-completed",
      idempotencyKey: "a".repeat(64),
      kind: "apply",
      status: "completed",
      capability: { capability: "github-source", status: "online", checkedAt: "2026-08-04T13:00:00.000Z" },
      summary: { discoveredCount: 1, selectedCount: 1, changedCount: 2, unchangedCount: 2, deletedCount: 0, failedCount: 0 },
      apply: receipt,
    },
  });
  const discovery = job({ id: "discovery", kind: "discovery", status: "completed", updatedAt: "2026-08-04T10:00:00.000Z", result: discoveryResult });

  const first = projectGitHubRepositorySyncSummaries([completed, discovery], []);
  const repeated = projectGitHubRepositorySyncSummaries([discovery, completed], []);
  assert.deepEqual(repeated, first);
  assert.deepEqual(first.find((item) => item.repositoryId === "1"), {
    repositoryId: "1",
    repositoryOwner: "coreline-ai",
    repositoryName: "alpha-renamed",
    status: "synced",
    documentCount: 4,
    nodeCount: 120,
    edgeCount: 140,
    commitSha: "b".repeat(40),
    lastSyncedAt: "2026-08-04T13:00:00.000Z",
    lastAttemptAt: "2026-08-04T13:00:00.000Z",
    errorCode: undefined,
    errorMessage: undefined,
  });
});
