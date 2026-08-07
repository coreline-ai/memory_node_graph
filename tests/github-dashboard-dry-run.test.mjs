import assert from "node:assert/strict";
import test from "node:test";

import { projectGitHubDashboardDryRun } from "../.connector-dist/app/lib/github/dashboard-dry-run.js";

const file = (repositoryId, path, blobSha) => ({
  repositoryId,
  path,
  role: path === "README.md" ? "readme" : "dev-plan",
  blobSha,
  size: 100,
  sourceKey: `github:${repositoryId}:${path}`,
  rawUrl: `https://raw.githubusercontent.com/coreline-ai/atlas/main/${path}`,
  sourceUrl: `https://github.com/coreline-ai/atlas/blob/main/${path}`,
});

const previewJob = ({ id, updatedAt, repository }) => ({
  id,
  idempotencyKey: id.padEnd(64, "a").slice(0, 64),
  kind: "preview",
  owner: "coreline-ai",
  status: "completed",
  input: {
    jobId: id,
    idempotencyKey: id.padEnd(64, "a").slice(0, 64),
    kind: "preview",
    owner: "coreline-ai",
    selectedRepositoryIds: [repository.repositoryId],
  },
  result: {
    jobId: id,
    idempotencyKey: id.padEnd(64, "a").slice(0, 64),
    kind: "preview",
    status: "completed",
    capability: { capability: "github-source", status: "online", checkedAt: updatedAt },
    summary: { discoveredCount: 1, selectedCount: 1, changedCount: 0, unchangedCount: 0, deletedCount: 0, failedCount: 0 },
    preview: {
      status: repository.status,
      selectedRepositoryIds: [repository.repositoryId],
      selectionDigest: "s".repeat(64),
      manifestDigest: id.padEnd(64, "f").slice(0, 64),
      repositories: [repository],
      totals: {
        repositories: 1,
        ready: repository.status === "ready" ? 1 : 0,
        blocked: repository.status === "blocked" ? 1 : 0,
        files: repository.files.length,
        readme: repository.files.filter((item) => item.role === "readme").length,
        devPlan: repository.files.filter((item) => item.role === "dev-plan").length,
        bytes: repository.files.reduce((sum, item) => sum + item.size, 0),
        skipped: repository.skipped.length,
      },
      generatedAt: updatedAt,
    },
  },
  attemptCount: 1,
  maxAttempts: 3,
  manualRetryCount: 0,
  createdAt: updatedAt,
  updatedAt,
});

test("최신 완료 Preview는 현재 blob과 비교해 create·update·delete·unchanged를 결정적으로 집계한다", () => {
  const oldRepository = {
    repositoryId: "1001",
    owner: "coreline-ai",
    repositoryName: "old-atlas",
    defaultBranch: "main",
    commitSha: "1".repeat(40),
    status: "ready",
    treeStrategy: "recursive",
    files: [file("1001", "README.md", "a".repeat(40))],
    skipped: [],
    digest: "1".repeat(64),
  };
  const latestRepository = {
    ...oldRepository,
    repositoryName: "atlas",
    commitSha: "2".repeat(40),
    files: [
      file("1001", "README.md", "a".repeat(40)),
      file("1001", "dev-plan/update.md", "c".repeat(40)),
      file("1001", "dev-plan/create.md", "d".repeat(40)),
    ],
    digest: "2".repeat(64),
  };
  const jobs = [
    previewJob({ id: "preview-latest", updatedAt: "2026-08-04T14:00:00.000Z", repository: latestRepository }),
    previewJob({ id: "preview-old", updatedAt: "2026-08-04T13:00:00.000Z", repository: oldRepository }),
  ];
  const currentDocuments = [
    { repositoryId: "1001", sourceKey: "github:1001:README.md", relativePath: "README.md", blobSha: "a".repeat(40) },
    { repositoryId: "1001", sourceKey: "github:1001:dev-plan/update.md", relativePath: "dev-plan/update.md", blobSha: "b".repeat(40) },
    { repositoryId: "1001", sourceKey: "github:1001:dev-plan/delete.md", relativePath: "dev-plan/delete.md", blobSha: "e".repeat(40) },
  ];

  const projected = projectGitHubDashboardDryRun(jobs, currentDocuments);
  const repeated = projectGitHubDashboardDryRun([...jobs].reverse(), currentDocuments);

  assert.deepEqual(repeated, projected);
  assert.equal(projected.previewJobId, "preview-latest");
  assert.equal(projected.status, "ready");
  assert.equal(projected.repositories[0].repositoryName, "atlas");
  assert.deepEqual(projected.summary, {
    createCount: 1,
    updateCount: 1,
    deleteCount: 1,
    unchangedCount: 1,
  });
  assert.deepEqual(
    projected.repositories[0].actions.map(({ action, relativePath }) => ({ action, relativePath })),
    [
      { action: "create", relativePath: "dev-plan/create.md" },
      { action: "delete", relativePath: "dev-plan/delete.md" },
      { action: "update", relativePath: "dev-plan/update.md" },
      { action: "unchanged", relativePath: "README.md" },
    ],
  );
});

test("blocked Preview는 현재 문서가 있어도 삭제 계획을 만들지 않는다", () => {
  const repository = {
    repositoryId: "1001",
    owner: "coreline-ai",
    repositoryName: "atlas",
    defaultBranch: "main",
    commitSha: "3".repeat(40),
    status: "blocked",
    blockedReason: "tree_truncated_without_fallback",
    treeStrategy: "contents-fallback",
    files: [],
    skipped: [],
  };
  const projected = projectGitHubDashboardDryRun([
    previewJob({ id: "preview-blocked", updatedAt: "2026-08-04T15:00:00.000Z", repository }),
  ], [{
    repositoryId: "1001",
    sourceKey: "github:1001:README.md",
    relativePath: "README.md",
    blobSha: "a".repeat(40),
  }]);

  assert.equal(projected.status, "blocked");
  assert.deepEqual(projected.summary, {
    createCount: 0,
    updateCount: 0,
    deleteCount: 0,
    unchangedCount: 0,
  });
  assert.deepEqual(projected.repositories[0].actions, []);
});
