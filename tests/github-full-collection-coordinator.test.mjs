import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectionRequestNonce,
  createCollectionCheckpoint,
  renderCollectionReport,
  runCollection,
  summarizeCollectionCheckpoint,
} from "../scripts/collect-all-github-markdown.mjs";

const receipt = {
  discoveryJobId: "github-source:discovery:test",
  totals: { previewed: 3 },
  repositories: [
    { repositoryId: "1003", repositoryName: "empty", fileCount: 0, bytes: 0 },
    { repositoryId: "1001", repositoryName: "first", fileCount: 2, bytes: 200 },
    { repositoryId: "1002", repositoryName: "second", fileCount: 21, bytes: 2_100 },
  ],
};

test("전체 수집 checkpoint는 Preview 저장소를 결정적 순서로 한 번씩 보존한다", () => {
  const checkpoint = createCollectionCheckpoint(receipt, {
    runId: "collection-test",
    sourceReceipt: "preview.json",
    createdAt: "2026-08-05T12:00:00.000Z",
  });
  assert.deepEqual(
    checkpoint.repositories.map((repository) => repository.repositoryId),
    ["1001", "1002", "1003"],
  );
  assert.ok(checkpoint.repositories.every((repository) => repository.status === "pending"));
  assert.throws(() => createCollectionCheckpoint({
    ...receipt,
    repositories: [...receipt.repositories, receipt.repositories[0]],
    totals: { previewed: 4 },
  }), /중복/);
});

test("전체 수집 집계는 완료·빈·실패를 숨기지 않고 실제 영수증만 합산한다", () => {
  const checkpoint = createCollectionCheckpoint(receipt, {
    runId: "collection-test",
    createdAt: "2026-08-05T12:00:00.000Z",
  });
  checkpoint.repositories[0].status = "completed";
  checkpoint.repositories[0].receipt = {
    fileCount: 2,
    createdCount: 2,
    updatedCount: 0,
    unchangedCount: 0,
    deletedCount: 0,
    nodeCount: 12,
    edgeCount: 11,
  };
  checkpoint.repositories[1].status = "failed";
  checkpoint.repositories[1].errorCode = "github_rate_limited";
  checkpoint.repositories[2].status = "empty";

  assert.deepEqual(summarizeCollectionCheckpoint(checkpoint), {
    repositories: 3,
    completed: 1,
    empty: 1,
    blocked: 0,
    failed: 1,
    pending: 0,
    documents: 2,
    created: 2,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    nodes: 12,
    edges: 11,
  });
  assert.match(renderCollectionReport(checkpoint), /github_rate_limited/);
});

test("재시도 한도를 소진한 Apply는 새 nonce의 교체 작업으로 복구한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-full-collection-"));
  const sourceReceipt = join(directory, "preview.json");
  const checkpointPath = join(directory, "checkpoint.json");
  const outputJson = join(directory, "receipt.json");
  const outputMarkdown = join(directory, "receipt.md");
  const singleReceipt = {
    discoveryJobId: "github-source:discovery:test",
    totals: { previewed: 1 },
    repositories: [receipt.repositories.find((repository) => repository.repositoryId === "1001")],
  };
  const checkpoint = createCollectionCheckpoint(singleReceipt, {
    runId: "collection-recovery",
    sourceReceipt,
    createdAt: "2026-08-05T12:00:00.000Z",
  });
  Object.assign(checkpoint.repositories[0], {
    status: "failed",
    failureStage: "applying",
    previewJobId: "preview-old",
    applyJobId: "apply-old",
    manualRetriesUsed: 2,
  });
  await writeFile(sourceReceipt, JSON.stringify(singleReceipt), "utf8");
  await writeFile(checkpointPath, JSON.stringify(checkpoint), "utf8");

  const originalFetch = globalThis.fetch;
  const queuedBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/preview-old")) {
      return Response.json({ job: {
        id: "preview-old",
        kind: "preview",
        status: "completed",
        manualRetryCount: 0,
        result: { preview: {
          selectedRepositoryIds: ["1001"],
          manifestDigest: "a".repeat(64),
          repositories: [{
            repositoryId: "1001",
            status: "ready",
            files: [{ path: "README.md", size: 200 }],
          }],
        } },
      } });
    }
    if (path.endsWith("/apply-old")) {
      return Response.json({ job: {
        id: "apply-old",
        kind: "apply",
        status: "failed",
        manualRetryCount: 2,
        errorCode: "retry_exhausted",
        errorMessage: "old job exhausted",
      } });
    }
    if (path.endsWith("/apply-replacement")) {
      return Response.json({ job: {
        id: "apply-replacement",
        kind: "apply",
        status: "completed",
        manualRetryCount: 0,
        result: { apply: {
          repositoryId: "1001",
          repositoryName: "first",
          manifestDigest: "a".repeat(64),
          fileCount: 1,
          createdCount: 1,
          updatedCount: 0,
          unchangedCount: 0,
          deletedCount: 0,
          nodeCount: 4,
          edgeCount: 3,
        } },
      } });
    }
    if (path === "/api/github/source-jobs" && init.method === "POST") {
      queuedBodies.push(JSON.parse(init.body));
      return Response.json({ job: { id: "apply-replacement" }, created: true }, { status: 201 });
    }
    throw new Error(`예상하지 못한 fetch: ${init.method ?? "GET"} ${path}`);
  };

  try {
    await runCollection([
      "--base-url", "http://atlas.test",
      "--source-receipt", sourceReceipt,
      "--checkpoint", checkpointPath,
      "--output-json", outputJson,
      "--output-md", outputMarkdown,
      "--run-id", "collection-recovery",
      "--poll-ms", "250",
      "--timeout-ms", "1000",
      "--manual-retries", "2",
      "--retry-failed",
    ]);
    const stored = JSON.parse(await readFile(checkpointPath, "utf8"));
    assert.equal(stored.repositories[0].status, "completed");
    assert.equal(stored.repositories[0].applyCycle, 1);
    assert.equal(stored.repositories[0].applyJobId, "apply-replacement");
    assert.equal(queuedBodies.length, 1);
    assert.equal(
      queuedBodies[0].requestNonce,
      collectionRequestNonce("collection-recovery", "1001", "apply", 1),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
