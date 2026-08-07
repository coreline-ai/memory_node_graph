import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubApplyStageChunks,
  GITHUB_APPLY_CHUNK_MAX_FILES,
  hydrateGitHubApplyStageSubmission,
  parseGitHubApplyStageChunk,
} from "../.connector-dist/app/lib/github/apply-stage-contracts.js";
import { ConnectorClient } from "../.connector-dist/connector/client.js";

const document = (index) => {
  const content = `# Chunk ${index}\n\n${"가".repeat(620_000)}`;
  return {
    repositoryId: "1001",
    path: `dev-plan/chunk-${index}.md`,
    blobSha: String(index + 1).repeat(40),
    size: Buffer.byteLength(content),
    content,
  };
};

test("대용량 Apply는 문서 경계 chunk·checksum으로 staging하고 완전한 순서만 복원한다", async () => {
  const jobId = "github-source:apply:stage-test";
  const documents = [document(0), document(1), document(2)];
  const staged = await createGitHubApplyStageChunks(jobId, documents);
  assert.ok(staged.chunks.length >= 2);
  assert.deepEqual(staged.chunks.flatMap((chunk) => chunk.documents.map((item) => item.path)), documents.map((item) => item.path));
  for (const chunk of staged.chunks) {
    assert.deepEqual(await parseGitHubApplyStageChunk(chunk, jobId), chunk);
  }

  const submission = {
    jobId,
    applyPayload: {
      preview: { status: "ready" },
      reusedDocuments: [],
      downloadedAt: "2026-08-04T12:00:00.000Z",
      stage: staged.stage,
    },
  };
  const hydrated = await hydrateGitHubApplyStageSubmission(submission, jobId, staged.chunks);
  assert.equal(hydrated.staged, true);
  assert.deepEqual(hydrated.submission.applyPayload.documents.map((item) => item.path), documents.map((item) => item.path));

  await assert.rejects(
    parseGitHubApplyStageChunk({ ...staged.chunks[0], checksum: "0".repeat(64) }, jobId),
    /checksum/,
  );
  await assert.rejects(
    hydrateGitHubApplyStageSubmission(submission, jobId, staged.chunks.slice(1)),
    /모두 업로드되지 않았습니다/,
  );
  await assert.rejects(
    hydrateGitHubApplyStageSubmission(submission, jobId, [...staged.chunks].reverse()),
    /순서/,
  );
});

test("65개 Markdown은 최대 20개 문서씩 4개 stage chunk로 분할된다", async () => {
  const documents = Array.from({ length: 65 }, (_, index) => ({
    repositoryId: "1001",
    path: `dev-plan/small-${String(index).padStart(2, "0")}.md`,
    blobSha: String((index % 9) + 1).repeat(40),
    size: 16,
    content: `# 문서 ${index}\n`,
  }));
  const staged = await createGitHubApplyStageChunks("github-source:apply:65-files", documents);

  assert.equal(GITHUB_APPLY_CHUNK_MAX_FILES, 20);
  assert.deepEqual(staged.chunks.map((chunk) => chunk.documents.length), [20, 20, 20, 5]);
  assert.deepEqual(staged.chunks.flatMap((chunk) => chunk.documents), documents);
});

test("Connector client는 512KB 초과 Apply 원문을 stage로 보내고 finalize에는 참조만 전송한다", async () => {
  const jobId = "github-source:apply:client-stage-test";
  const large = {
    repositoryId: "1001",
    path: "README.md",
    blobSha: "a".repeat(40),
    size: 620_000,
    content: "x".repeat(620_000),
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/stage")) {
      return Response.json({
        stage: {
          chunkIndex: body.chunkIndex,
          checksum: body.checksum,
          receivedChunks: body.chunkIndex + 1,
          totalChunks: body.totalChunks,
        },
      });
    }
    return Response.json({ job: { id: jobId, status: "completed" } });
  };
  try {
    const client = new ConnectorClient({
      baseUrl: "http://localhost:3000",
      token: "",
      connectorId: "stage-client-test",
    });
    await client.submitGitHubSource(jobId, {
      jobId,
      idempotencyKey: "stage-client-key",
      kind: "apply",
      status: "completed",
      capability: {
        capability: "github-source",
        status: "online",
        checkedAt: "2026-08-04T12:00:00.000Z",
      },
      summary: {
        discoveredCount: 1,
        selectedCount: 1,
        changedCount: 1,
        unchangedCount: 0,
        deletedCount: 0,
        failedCount: 0,
      },
      applyPayload: {
        preview: {},
        documents: [large],
        reusedDocuments: [],
        downloadedAt: "2026-08-04T12:00:00.000Z",
      },
    });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/stage$/);
    assert.equal(calls[0].body.documents[0].content.length, 620_000);
    assert.match(calls[1].url, /\/result$/);
    assert.equal("documents" in calls[1].body.applyPayload, false);
    assert.equal(typeof calls[1].body.applyPayload.stage.stageDigest, "string");
    assert.doesNotMatch(JSON.stringify(calls[1].body), /x{100}/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Connector client는 작은 문서도 20개를 초과하면 stage 전송한다", async () => {
  const jobId = "github-source:apply:client-21-files";
  const documents = Array.from({ length: 21 }, (_, index) => ({
    repositoryId: "1001",
    path: `dev-plan/part-${index}.md`,
    blobSha: String((index % 9) + 1).repeat(40),
    size: 10,
    content: `# ${index}\n`,
  }));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/stage")) {
      return Response.json({
        stage: {
          chunkIndex: body.chunkIndex,
          checksum: body.checksum,
          receivedChunks: body.chunkIndex + 1,
          totalChunks: body.totalChunks,
        },
      });
    }
    return Response.json({ job: { id: jobId, status: "completed" } });
  };
  try {
    const client = new ConnectorClient({
      baseUrl: "http://localhost:3000",
      token: "",
      connectorId: "stage-client-21-files",
    });
    await client.submitGitHubSource(jobId, {
      jobId,
      idempotencyKey: "stage-client-21-files-key",
      kind: "apply",
      status: "completed",
      capability: {
        capability: "github-source",
        status: "online",
        checkedAt: "2026-08-05T12:00:00.000Z",
      },
      summary: {
        discoveredCount: 1,
        selectedCount: 1,
        changedCount: documents.length,
        unchangedCount: 0,
        deletedCount: 0,
        failedCount: 0,
      },
      applyPayload: {
        preview: {},
        documents,
        reusedDocuments: [],
        downloadedAt: "2026-08-05T12:00:00.000Z",
      },
    });

    const stageCalls = calls.filter((call) => call.url.endsWith("/stage"));
    const finalize = calls.at(-1);
    assert.deepEqual(stageCalls.map((call) => call.body.documents.length), [20, 1]);
    assert.ok(finalize.url.endsWith("/result"));
    assert.equal("documents" in finalize.body.applyPayload, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
