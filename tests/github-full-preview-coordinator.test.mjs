import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregatePreviewJobs,
  renderPreviewReport,
  splitRepositoryIds,
} from "../scripts/preview-all-github-repositories.mjs";

const ids = (count) => Array.from({ length: count }, (_, index) => String(1_000 + index));

test("full preview splits 115 repositories into deterministic 10-item batches", () => {
  const batches = splitRepositoryIds(ids(115).reverse());
  assert.equal(batches.length, 12);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 5]);
  assert.deepEqual(batches.flat(), ids(115));
  assert.deepEqual(splitRepositoryIds([], 10), []);
  assert.throws(() => splitRepositoryIds(["1000", "1000"]), /중복/);
  assert.throws(() => splitRepositoryIds(["repository"]), /형식/);
});

test("full preview keeps all boundary-size repositories without overflow", () => {
  const cases = [
    [0, []],
    [1, [1]],
    [10, [10]],
    [11, [10, 1]],
    [115, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 5]],
    [500, Array.from({ length: 50 }, () => 10)],
  ];

  cases.forEach(([count, expectedBatchSizes]) => {
    const input = ids(count).reverse();
    const batches = splitRepositoryIds(input);
    assert.deepEqual(batches.map((batch) => batch.length), expectedBatchSizes);
    assert.deepEqual(batches.flat(), ids(count));
  });
});

const manifest = (repositoryId, options = {}) => ({
  repositoryId,
  owner: "coreline-ai",
  repositoryName: `repo-${repositoryId}`,
  defaultBranch: "main",
  commitSha: repositoryId.padEnd(40, "a").slice(0, 40),
  status: options.status ?? "ready",
  treeStrategy: "recursive",
  files: options.files ?? [{ role: "readme", size: 120 }],
  skipped: options.skipped ?? [],
  digest: repositoryId.padEnd(64, "b").slice(0, 64),
  blockedReason: options.blockedReason,
});

const previewJob = (id, repositories) => ({
  id,
  kind: "preview",
  status: "completed",
  result: { preview: { repositories } },
});

test("full preview aggregates repository manifests without losing empty or blocked repositories", () => {
  const receipt = aggregatePreviewJobs({
    discoveryJobId: "discovery",
    repositoryIds: ["1000", "1001", "1002"],
    previewJobIds: ["batch-1", "batch-2"],
    jobs: [
      previewJob("batch-1", [
        manifest("1000", { files: [{ role: "readme", size: 120 }, { role: "dev-plan", size: 80 }] }),
        manifest("1001", { files: [] }),
      ]),
      previewJob("batch-2", [manifest("1002", {
        status: "blocked",
        files: [],
        blockedReason: "tree_truncated_without_fallback",
        skipped: [{ path: "dev-plan/link.md", reason: "symbolic_link" }],
      })]),
    ],
    generatedAt: "2026-08-05T12:00:00.000Z",
  });

  assert.deepEqual(receipt.totals, {
    discovered: 3,
    previewed: 3,
    ready: 2,
    blocked: 1,
    empty: 1,
    repositoriesWithDocuments: 1,
    applyEligibleReady: 2,
    applyLimitExceeded: 0,
    stageRequired: 0,
    files: 2,
    readme: 1,
    devPlan: 1,
    bytes: 200,
    skipped: 1,
  });
  assert.deepEqual(receipt.skippedReasons, { symbolic_link: 1 });
  assert.match(renderPreviewReport(receipt), /Discovery 선택 저장소 \| 3/);
  assert.match(renderPreviewReport(receipt), /repo-1002/);
});

test("full preview rejects missing, duplicate, and incomplete batch results", () => {
  assert.throws(() => aggregatePreviewJobs({
    discoveryJobId: "discovery",
    repositoryIds: ["1000", "1001"],
    previewJobIds: ["batch"],
    jobs: [previewJob("batch", [manifest("1000")])],
  }), /중복·누락/);

  assert.throws(() => aggregatePreviewJobs({
    discoveryJobId: "discovery",
    repositoryIds: ["1000"],
    previewJobIds: ["batch"],
    jobs: [{ ...previewJob("batch", [manifest("1000")]), status: "failed" }],
  }), /완료되지 않았습니다/);
});

test("실패 batch의 교체 결과는 기존 완료 batch를 중복 집계하지 않는다", () => {
  const receipt = aggregatePreviewJobs({
    discoveryJobId: "discovery",
    repositoryIds: ["1000", "1001"],
    previewJobIds: ["batch-1", "batch-2-retry"],
    jobs: [
      previewJob("batch-1", [manifest("1000")]),
      { ...previewJob("batch-2-failed", [manifest("1001")]), status: "failed" },
      previewJob("batch-2-retry", [manifest("1001")]),
    ],
    generatedAt: "2026-08-05T12:00:00.000Z",
  });

  assert.equal(receipt.totals.previewed, 2);
  assert.deepEqual(receipt.repositories.map((repository) => repository.repositoryId), ["1000", "1001"]);
  assert.deepEqual(receipt.previewJobIds, ["batch-1", "batch-2-retry"]);
});
