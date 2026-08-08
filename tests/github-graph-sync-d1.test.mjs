import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createGitHubApplyStageChunks,
} from "../.runtime-dist/app/lib/github/apply-stage-contracts.js";

delete process.env.ATLAS_MEMORY_STORAGE;
process.env.ATLAS_TEST_MODE = "true";
process.env.ATLAS_WRITE_ACCESS = "public";

class SqliteD1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1Statement(this.database, this.sql, bindings);
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) ?? null;
  }

  async all() {
    const results = this.database.prepare(this.sql).all(...this.bindings);
    return { success: true, results, meta: { changes: 0 } };
  }
}

class SqliteD1Database {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    this.batchSizes = [];
    this.failBatchPattern = null;
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.batchSizes.push(statements.length);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        if (this.failBatchPattern?.test(statement.sql)) {
          this.failBatchPattern = null;
          throw new Error("테스트용 D1 graph commit batch 실패");
        }
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

let workerPromise;
const worker = () => workerPromise ??= import(new URL("../dist/server/index.js", import.meta.url).href)
  .then((module) => module.default);

const runtimeHeaders = {
  authorization: "Bearer d1-graph-sync-secret",
  "content-type": "application/json",
  "x-atlas-runtime-id": "d1-graph-sync-runtime",
};
const capability = {
  capability: "github-source",
  status: "online",
  accountLogin: "coreline-ai",
  host: "github.com",
  checkedAt: "2026-08-04T12:30:00.000Z",
};

const gitBlobSha = (content) => {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

function applyPayload({ repositoryId, repositoryName, commitSha, digest, documents }) {
  const normalized = [...documents]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, content }) => {
      const blobSha = gitBlobSha(content);
      const size = Buffer.byteLength(content);
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      return {
        repositoryId,
        path,
        role: path === "README.md" ? "readme" : "dev-plan",
        blobSha,
        size,
        sourceKey: `github:${repositoryId}:${path}`,
        rawUrl: `https://raw.githubusercontent.com/coreline-ai/${repositoryName}/${commitSha}/${encodedPath}`,
        sourceUrl: `https://github.com/coreline-ai/${repositoryName}/blob/${commitSha}/${encodedPath}`,
        content,
      };
    });
  const files = normalized.map((item) => ({
    repositoryId: item.repositoryId,
    path: item.path,
    role: item.role,
    blobSha: item.blobSha,
    size: item.size,
    sourceKey: item.sourceKey,
    rawUrl: item.rawUrl,
    sourceUrl: item.sourceUrl,
  }));
  const readme = files.filter((file) => file.role === "readme").length;
  return {
    preview: {
      status: "ready",
      selectedRepositoryIds: [repositoryId],
      selectionDigest: "e".repeat(64),
      manifestDigest: digest,
      repositories: [{
        repositoryId,
        owner: "coreline-ai",
        repositoryName,
        defaultBranch: "main",
        commitSha,
        status: "ready",
        treeStrategy: "recursive",
        files,
        skipped: [],
        digest: "f".repeat(64),
      }],
      totals: {
        repositories: 1,
        ready: 1,
        blocked: 0,
        files: files.length,
        readme,
        devPlan: files.length - readme,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        skipped: 0,
      },
      generatedAt: "2026-08-04T12:30:00.000Z",
    },
    documents: normalized.map((item) => ({
      repositoryId: item.repositoryId,
      path: item.path,
      blobSha: item.blobSha,
      size: item.size,
      content: item.content,
    })),
    reusedDocuments: [],
    downloadedAt: "2026-08-04T12:30:01.000Z",
  };
}

async function request(database, path, init) {
  const handler = await worker();
  return handler.fetch(
    new Request(`http://localhost${path}`, init),
    { DB: database, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function runApply(database, { payload, nonce }) {
  const created = await request(database, "/api/github/source-jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "apply",
      owner: "coreline-ai",
      selectedRepositoryIds: payload.preview.selectedRepositoryIds,
      manifestDigest: payload.preview.manifestDigest,
      requestNonce: nonce,
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const queued = (await created.json()).job;
  await request(database, "/api/runtime/status", {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify(capability),
  });
  const claimedResponse = await request(database, "/api/github/source-jobs/claim", {
    method: "POST",
    headers: runtimeHeaders,
    body: "{}",
  });
  assert.equal(claimedResponse.status, 200, await claimedResponse.clone().text());
  const claimed = (await claimedResponse.json()).job;
  assert.equal(claimed.id, queued.id);
  await request(database, `/api/github/source-jobs/${encodeURIComponent(claimed.id)}/start`, {
    method: "POST",
    headers: runtimeHeaders,
    body: "{}",
  });
  const reusable = queued.input.reusableDocuments ?? [];
  const reusablePaths = new Set(reusable.map((document) => document.path));
  const applyPayloadValue = {
    ...payload,
    documents: payload.documents.filter((document) => !reusablePaths.has(document.path)),
    reusedDocuments: reusable,
  };
  const shouldStage = applyPayloadValue.documents.length > 20
    || Buffer.byteLength(JSON.stringify(applyPayloadValue)) > 512 * 1024;
  const staged = shouldStage
    ? await createGitHubApplyStageChunks(claimed.id, applyPayloadValue.documents)
    : null;
  if (staged) {
    for (const chunk of staged.chunks) {
      const stagedResponse = await request(
        database,
        `/api/github/source-jobs/${encodeURIComponent(claimed.id)}/stage`,
        {
          method: "POST",
          headers: runtimeHeaders,
          body: JSON.stringify(chunk),
        },
      );
      assert.equal(stagedResponse.status, 200, await stagedResponse.clone().text());
    }
  }
  const result = await request(database, `/api/github/source-jobs/${encodeURIComponent(claimed.id)}/result`, {
    method: "POST",
    headers: runtimeHeaders,
    body: JSON.stringify({
      jobId: claimed.id,
      idempotencyKey: claimed.idempotencyKey,
      kind: "apply",
      status: "completed",
      capability,
      summary: {
        discoveredCount: 1,
        selectedCount: 1,
        changedCount: applyPayloadValue.documents.length,
        unchangedCount: reusable.length,
        deletedCount: 0,
        failedCount: 0,
      },
      applyPayload: staged ? {
        preview: applyPayloadValue.preview,
        reusedDocuments: applyPayloadValue.reusedDocuments,
        downloadedAt: applyPayloadValue.downloadedAt,
        stage: staged.stage,
      } : applyPayloadValue,
    }),
  });
  return { result, claimed };
}

const oldDocuments = [
  { path: "README.md", content: "# OLD_README_ONLY\n\n기술: `TypeScript`\n" },
  ...Array.from({ length: 19 }, (_, index) => ({
    path: `dev-plan/old-${String(index).padStart(2, "0")}.md`,
    content: `# OLD_PLAN_${index}\n\n- [ ] 이전 작업 ${index}\n\n기술: \`TypeScript\`\n`,
  })),
];
const newDocuments = [
  {
    path: "README.md",
    content: "# UPDATED_README\n\n기술: `React`\n\n기능: 증분 GitHub 동기화\n",
  },
  ...Array.from({ length: 19 }, (_, index) => ({
    path: `dev-plan/new-${String(index).padStart(2, "0")}.md`,
    content: `# NEW_PLAN_${index}\n\n- [x] 신규 작업 ${index}\n\n기술: \`React\`\n`,
  })),
];

test("D1 Graph commit은 20·65문서 저장소를 90문장 이내에서 원자 적용한다", async () => {
  const database = new SqliteD1Database();
  globalThis.__AI_ATLAS_TEST_D1__ = database;
  try {
    const first = await runApply(database, {
      nonce: "d1-initial-20",
      payload: applyPayload({
        repositoryId: "2001",
        repositoryName: "old-repository-name",
        commitSha: "1".repeat(40),
        digest: "1".repeat(64),
        documents: oldDocuments,
      }),
    });
    assert.equal(first.result.status, 200, await first.result.clone().text());
    const secondRepository = await runApply(database, {
      nonce: "d1-shared-entity",
      payload: applyPayload({
        repositoryId: "2002",
        repositoryName: "shared-entity-repository",
        commitSha: "2".repeat(40),
        digest: "2".repeat(64),
        documents: [{ path: "README.md", content: "# SHARED_REPOSITORY\n\n기술: `TypeScript`\n" }],
      }),
    });
    assert.equal(secondRepository.result.status, 200, await secondRepository.result.clone().text());

    const sameNamedReadmes = database.database.prepare(
      "SELECT id, repository_id FROM documents WHERE relative_path = 'README.md' ORDER BY repository_id",
    ).all();
    assert.deepEqual(sameNamedReadmes.map((row) => row.repository_id), ["2001", "2002"]);
    assert.equal(new Set(sameNamedReadmes.map((row) => row.id)).size, 2);

    const oldRows = database.database.prepare(
      "SELECT id, relative_path FROM documents WHERE repository_id = '2001' ORDER BY relative_path",
    ).all();
    assert.equal(oldRows.length, 20);
    const oldIds = oldRows.map((row) => row.id);

    database.failBatchPattern = /INSERT OR REPLACE INTO github_sync_runs/;
    const failed = await runApply(database, {
      nonce: "d1-rollback-20",
      payload: applyPayload({
        repositoryId: "2001",
        repositoryName: "renamed-repository",
        commitSha: "3".repeat(40),
        digest: "3".repeat(64),
        documents: newDocuments,
      }),
    });
    assert.equal(failed.result.status, 500);
    const afterFailure = database.database.prepare(
      "SELECT id, relative_path, repository_name FROM documents WHERE repository_id = '2001' ORDER BY relative_path",
    ).all();
    assert.deepEqual(afterFailure.map((row) => row.id), oldIds);
    assert.ok(afterFailure.every((row) => row.repository_name === "old-repository-name"));
    assert.equal(database.database.prepare(
      "SELECT COUNT(*) AS count FROM staged_document_blocks WHERE stage_id = ?",
    ).get(failed.claimed.id).count, 0);
    const failedJob = await request(database, `/api/github/source-jobs/${encodeURIComponent(failed.claimed.id)}/fail`, {
      method: "POST",
      headers: runtimeHeaders,
      body: JSON.stringify({
        errorCode: "invalid_result",
        errorMessage: "D1 batch rollback fixture",
        retryable: false,
      }),
    });
    assert.equal(failedJob.status, 200);
    const failedSyncResponse = await request(database, "/api/github/source-jobs");
    assert.equal(failedSyncResponse.status, 200, await failedSyncResponse.clone().text());
    const failedSync = await failedSyncResponse.json();
    const failedRepository = failedSync.repositorySync.find((repository) =>
      repository.repositoryId === "2001");
    assert.equal(failedRepository.status, "failed");
    assert.deepEqual(failedRepository.retry, {
      jobId: failed.claimed.id,
      manualRetryCount: 0,
      maxManualRetries: 2,
      available: true,
    });
    const retriedRepositoryResponse = await request(
      database,
      `/api/github/source-jobs/${encodeURIComponent(failed.claimed.id)}/retry`,
      { method: "POST" },
    );
    assert.equal(retriedRepositoryResponse.status, 200, await retriedRepositoryResponse.clone().text());
    const retriedRepositoryJob = (await retriedRepositoryResponse.json()).job;
    assert.equal(retriedRepositoryJob.status, "queued");
    assert.equal(retriedRepositoryJob.manualRetryCount, 1);
    const retryingSync = await (await request(database, "/api/github/source-jobs")).json();
    const retryingRepository = retryingSync.repositorySync.find((repository) =>
      repository.repositoryId === "2001");
    assert.equal(retryingRepository.status, "syncing");
    assert.equal(retryingRepository.retry, undefined);
    const cancelledRetry = await request(
      database,
      `/api/github/source-jobs/${encodeURIComponent(failed.claimed.id)}/cancel`,
      { method: "POST" },
    );
    assert.equal((await cancelledRetry.json()).job.status, "cancelled");

    const replacementPayload = applyPayload({
      repositoryId: "2001",
      repositoryName: "renamed-repository",
      commitSha: "4".repeat(40),
      digest: "4".repeat(64),
      documents: newDocuments,
    });
    const replaced = await runApply(database, {
      nonce: "d1-replace-20",
      payload: replacementPayload,
    });
    assert.equal(replaced.result.status, 200, await replaced.result.clone().text());
    const receipt = (await replaced.result.json()).job.result.apply;
    assert.equal(receipt.createdCount, 19);
    assert.equal(receipt.updatedCount, 1);
    assert.equal(receipt.deletedCount, 19);
    const newRows = database.database.prepare(
      "SELECT id, relative_path, repository_name FROM documents WHERE repository_id = '2001' ORDER BY relative_path",
    ).all();
    assert.equal(newRows.length, 20);
    assert.deepEqual(newRows.map((row) => row.relative_path), [
      "README.md",
      ...Array.from({ length: 19 }, (_, index) => `dev-plan/new-${String(index).padStart(2, "0")}.md`),
    ]);
    assert.ok(newRows.every((row) => row.repository_name === "renamed-repository"));
    const documentDashboard = await (await request(database, "/api/documents")).json();
    const renamedRepositoryDocuments = documentDashboard.documents.filter((document) =>
      document.sourceType === "github" && document.sourceLabel.startsWith("renamed-repository · "),
    );
    assert.equal(renamedRepositoryDocuments.length, 20);
    assert.ok(renamedRepositoryDocuments.some((document) =>
      document.sourceLabel === "renamed-repository · README.md",
    ));
    assert.equal(renamedRepositoryDocuments.filter((document) =>
      document.sourceLabel.startsWith("renamed-repository · dev-plan/new-"),
    ).length, 19);
    const retainedOldIds = database.database.prepare(
      "SELECT id, relative_path, blob_sha FROM documents WHERE id IN (" + oldIds.map(() => "?").join(",") + ")",
    ).all(...oldIds);
    assert.deepEqual(retainedOldIds.map((row) => row.relative_path), ["README.md"]);
    assert.equal(retainedOldIds[0].blob_sha, gitBlobSha(newDocuments[0].content));
    assert.equal(database.database.prepare(
      "SELECT COUNT(*) AS count FROM entities WHERE label = 'TypeScript'",
    ).get().count, 1);
    assert.equal(database.database.prepare(`SELECT COUNT(*) AS count FROM entity_mentions m
      JOIN entities e ON e.id = m.entity_id WHERE e.label = 'TypeScript'`).get().count, 1);
    assert.ok(Math.max(...database.batchSizes) <= 90);

    const repositoryGraph = await request(database, "/api/graph?scope=repository&repositoryId=2001");
    assert.equal(repositoryGraph.status, 200, await repositoryGraph.clone().text());
    const repositorySnapshot = await repositoryGraph.json();
    const completedTask = repositorySnapshot.nodes.find((node) =>
      node.tags.includes("task") && node.tags.includes("completed"));
    assert.ok(completedTask);
    assert.equal(completedTask.source?.repositoryName, "renamed-repository");
    assert.match(completedTask.source?.relativePath ?? "", /^dev-plan\/new-/);
    assert.equal(completedTask.source?.commitSha, "4".repeat(40));
    assert.match(completedTask.source?.sourceUrl ?? "", /#L\d+/);
    const dryRunPreviewCreated = await request(database, "/api/github/source-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "preview",
        owner: "coreline-ai",
        selectedRepositoryIds: ["2001"],
        requestNonce: "d1-p5f-dry-run-preview",
      }),
    });
    assert.equal(dryRunPreviewCreated.status, 201, await dryRunPreviewCreated.clone().text());
    const dryRunPreviewJob = (await dryRunPreviewCreated.json()).job;
    await request(database, "/api/runtime/status", {
      method: "POST",
      headers: runtimeHeaders,
      body: JSON.stringify(capability),
    });
    const dryRunPreviewClaimed = await request(database, "/api/github/source-jobs/claim", {
      method: "POST",
      headers: runtimeHeaders,
      body: "{}",
    });
    assert.equal((await dryRunPreviewClaimed.clone().json()).job.id, dryRunPreviewJob.id);
    await request(database, `/api/github/source-jobs/${encodeURIComponent(dryRunPreviewJob.id)}/start`, {
      method: "POST",
      headers: runtimeHeaders,
      body: "{}",
    });
    const dryRunPreviewCompleted = await request(
      database,
      `/api/github/source-jobs/${encodeURIComponent(dryRunPreviewJob.id)}/result`,
      {
        method: "POST",
        headers: runtimeHeaders,
        body: JSON.stringify({
          jobId: dryRunPreviewJob.id,
          idempotencyKey: dryRunPreviewJob.idempotencyKey,
          kind: "preview",
          status: "completed",
          capability,
          summary: {
            discoveredCount: 1,
            selectedCount: 1,
            changedCount: 0,
            unchangedCount: 20,
            deletedCount: 0,
            failedCount: 0,
          },
          preview: replacementPayload.preview,
        }),
      },
    );
    assert.equal(dryRunPreviewCompleted.status, 200, await dryRunPreviewCompleted.clone().text());
    const syncDashboardResponse = await request(database, "/api/github/source-jobs");
    assert.equal(syncDashboardResponse.status, 200, await syncDashboardResponse.clone().text());
    const syncDashboard = await syncDashboardResponse.json();
    const syncedRepository = syncDashboard.repositorySync.find((repository) =>
      repository.repositoryId === "2001");
    assert.equal(syncedRepository.status, "synced");
    assert.equal(syncedRepository.repositoryName, "renamed-repository");
    assert.equal(syncedRepository.documentCount, 20);
    assert.equal(syncedRepository.commitSha, "4".repeat(40));
    assert.ok(syncedRepository.nodeCount > 0);
    assert.ok(syncedRepository.edgeCount > 0);
    assert.deepEqual(syncDashboard.repositoryDryRun.summary, {
      createCount: 0,
      updateCount: 0,
      deleteCount: 0,
      unchangedCount: 20,
    });
    assert.equal(syncDashboard.repositoryDryRun.repositories[0].actions.length, 20);
    assert.ok(syncDashboard.repositoryDryRun.repositories[0].actions.every((action) =>
      action.action === "unchanged"));

    const metadataPayload = applyPayload({
      repositoryId: "2001",
      repositoryName: "renamed-again",
      commitSha: "5".repeat(40),
      digest: "5".repeat(64),
      documents: newDocuments,
    });
    const metadataOnly = await runApply(database, {
      nonce: "d1-metadata-update",
      payload: metadataPayload,
    });
    assert.equal(metadataOnly.result.status, 200, await metadataOnly.result.clone().text());
    const metadataReceipt = (await metadataOnly.result.json()).job.result.apply;
    assert.equal(metadataReceipt.unchangedCount, 20);
    assert.equal(metadataReceipt.createdCount + metadataReceipt.updatedCount + metadataReceipt.deletedCount, 0);
    const updatedMetadata = database.database.prepare(
      "SELECT DISTINCT repository_name, commit_sha FROM documents WHERE repository_id = '2001'",
    ).all();
    assert.equal(updatedMetadata.length, 1);
    assert.equal(updatedMetadata[0].repository_name, "renamed-again");
    assert.equal(updatedMetadata[0].commit_sha, "5".repeat(40));

    const incrementalRunId = "d1-incremental-no-op";
    const incrementalPreviewResponse = await request(database, "/api/github/incremental-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "preview",
        trigger: "manual",
        repositoryIds: ["2001"],
        runId: incrementalRunId,
      }),
    });
    assert.equal(incrementalPreviewResponse.status, 202, await incrementalPreviewResponse.clone().text());
    const incrementalPreviewJobId = (await incrementalPreviewResponse.json()).operations[0].jobId;
    const incrementalClaimResponse = await request(database, "/api/github/source-jobs/claim", {
      method: "POST",
      headers: runtimeHeaders,
      body: "{}",
    });
    const incrementalClaim = (await incrementalClaimResponse.json()).job;
    assert.equal(incrementalClaim.id, incrementalPreviewJobId);
    await request(database, `/api/github/source-jobs/${encodeURIComponent(incrementalClaim.id)}/start`, {
      method: "POST",
      headers: runtimeHeaders,
      body: "{}",
    });
    const incrementalPreviewCompleted = await request(
      database,
      `/api/github/source-jobs/${encodeURIComponent(incrementalClaim.id)}/result`,
      {
        method: "POST",
        headers: runtimeHeaders,
        body: JSON.stringify({
          jobId: incrementalClaim.id,
          idempotencyKey: incrementalClaim.idempotencyKey,
          kind: "preview",
          status: "completed",
          capability,
          summary: {
            discoveredCount: 1,
            selectedCount: 1,
            changedCount: 0,
            unchangedCount: 20,
            deletedCount: 0,
            failedCount: 0,
          },
          preview: metadataPayload.preview,
        }),
      },
    );
    assert.equal(incrementalPreviewCompleted.status, 200, await incrementalPreviewCompleted.clone().text());
    const incrementalReportResponse = await request(
      database,
      `/api/github/incremental-sync?runId=${incrementalRunId}`,
    );
    assert.equal(incrementalReportResponse.status, 200, await incrementalReportResponse.clone().text());
    const incrementalReport = await incrementalReportResponse.json();
    assert.equal(incrementalReport.repositories[0].status, "unchanged");
    assert.equal(incrementalReport.repositories[0].commitChanged, false);
    assert.equal(incrementalReport.repositories[0].manifestChanged, false);
    assert.equal(incrementalReport.repositories[0].lastSuccessful.manifestDigest, "5".repeat(64));

    const noOpApply = await request(database, "/api/github/incremental-sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "apply",
        trigger: "manual",
        repositoryIds: ["2001"],
        runId: incrementalRunId,
        approvedPreviewJobIds: [incrementalPreviewJobId],
      }),
    });
    assert.equal(noOpApply.status, 200, await noOpApply.clone().text());
    const noOpReceipt = await noOpApply.json();
    assert.equal(noOpReceipt.operations[0].status, "unchanged");
    assert.equal(noOpReceipt.repositories[0].status, "unchanged");
    assert.equal(noOpReceipt.repositories[0].applyJobId, undefined);

    const corpusBeforeIncrement = await (await request(database, "/api/graph?scope=corpus")).json();
    const corpusCachedRepeat = await (await request(database, "/api/graph?scope=corpus")).json();
    assert.equal(corpusCachedRepeat.meta.documentCount, corpusBeforeIncrement.meta.documentCount);

    // These repository IDs produce the same legacy 32-bit FNV mention ID for
    // their README document root nodes. Both Applies must coexist instead of
    // failing entity_mentions.id with a primary-key collision.
    const collisionRepositories = [
      { repositoryId: "1040815", repositoryName: "mention-collision-a", digest: "a" },
      { repositoryId: "1092351", repositoryName: "mention-collision-b", digest: "b" },
    ];
    for (const [index, repository] of collisionRepositories.entries()) {
      const collisionApply = await runApply(database, {
        nonce: `d1-mention-collision-${index}`,
        payload: applyPayload({
          repositoryId: repository.repositoryId,
          repositoryName: repository.repositoryName,
          commitSha: repository.digest.repeat(40),
          digest: repository.digest.repeat(64),
          documents: [{ path: "README.md", content: `# COLLISION_${index}\n` }],
        }),
      });
      assert.equal(collisionApply.result.status, 200, await collisionApply.result.clone().text());
    }
    const collisionMentions = database.database.prepare(`
      SELECT m.id
      FROM entity_mentions m
      INNER JOIN documents d ON d.id = m.document_id
      WHERE d.repository_id IN ('1040815', '1092351')
        AND m.entity_id = 'document:' || d.id
      ORDER BY d.repository_id
    `).all();
    assert.equal(collisionMentions.length, 2);
    assert.equal(new Set(collisionMentions.map((row) => row.id)).size, 2);
    const corpusAfterIncrement = await (await request(database, "/api/graph?scope=corpus")).json();
    assert.equal(corpusAfterIncrement.meta.documentCount, corpusBeforeIncrement.meta.documentCount + 2);
    assert.ok(corpusAfterIncrement.meta.corpusNodeCount > corpusBeforeIncrement.meta.corpusNodeCount);

    const repository65Documents = [
      { path: "README.md", content: "# LARGE_REPOSITORY\n\n기술: `TypeScript`\n" },
      ...Array.from({ length: 64 }, (_, index) => ({
        path: `dev-plan/phase-${String(index).padStart(2, "0")}.md`,
        content: `# Phase ${index}\n\n- [ ] 대형 저장소 작업 ${index}\n`,
      })),
    ];
    const repository65Payload = applyPayload({
      repositoryId: "2065",
      repositoryName: "repository-65-documents",
      commitSha: "6".repeat(40),
      digest: "6".repeat(64),
      documents: repository65Documents,
    });
    const first65 = await runApply(database, { nonce: "d1-stage-65", payload: repository65Payload });
    assert.equal(first65.result.status, 200, await first65.result.clone().text());
    const first65Receipt = (await first65.result.json()).job.result.apply;
    assert.equal(first65Receipt.fileCount, 65);
    assert.equal(first65Receipt.createdCount, 65);
    assert.equal(database.database.prepare(
      "SELECT COUNT(*) AS count FROM documents WHERE repository_id = '2065'",
    ).get().count, 65);
    assert.equal(database.database.prepare(
      "SELECT COUNT(*) AS count FROM github_apply_stage_chunks WHERE job_id = ?",
    ).get(first65.claimed.id).count, 0);
    assert.equal(database.database.prepare(
      "SELECT COUNT(*) AS count FROM staged_documents WHERE stage_id = ?",
    ).get(first65.claimed.id).count, 0);
    assert.ok(Math.max(...database.batchSizes) <= 90);

    database.database.prepare(
      "UPDATE documents SET parser_version = 'stale-parser' WHERE repository_id = '2065' AND relative_path = 'README.md'",
    ).run();
    const second65 = await runApply(database, { nonce: "d1-reuse-65", payload: repository65Payload });
    assert.equal(second65.result.status, 200, await second65.result.clone().text());
    assert.equal(second65.claimed.input.reusableDocuments.length, 64);
    const second65Receipt = (await second65.result.json()).job.result.apply;
    assert.equal(second65Receipt.fileCount, 65);
    assert.equal(second65Receipt.unchangedCount, 64);
    assert.equal(second65Receipt.createdCount, 0);
    assert.equal(second65Receipt.updatedCount, 1);
    assert.equal(database.database.prepare(
      "SELECT parser_version FROM documents WHERE repository_id = '2065' AND relative_path = 'README.md'",
    ).get().parser_version, "remark-ast-github-readme-4");
  } finally {
    delete globalThis.__AI_ATLAS_TEST_D1__;
    database.close();
    }
});
