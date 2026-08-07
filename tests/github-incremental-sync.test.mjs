import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulesPromise;

async function incrementalModules() {
  modulesPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-github-incremental-test-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const files = {
      "incremental-sync.mjs": (await readFile(
        new URL("../app/lib/github/incremental-sync.ts", import.meta.url), "utf8",
      ))
        .replace('from "./repository-manifest.js"', 'from "./repository-manifest.mjs"')
        .replace('from "./source-job-contracts.js"', 'from "./source-job-contracts.mjs"'),
      "source-job-contracts.mjs": (await readFile(
        new URL("../app/lib/github/source-job-contracts.ts", import.meta.url), "utf8",
      ))
        .replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"')
        .replace('from "./discovery-contracts.js"', 'from "./discovery-contracts.mjs"')
        .replace('from "./repository-manifest.js"', 'from "./repository-manifest.mjs"'),
      "repository-manifest.mjs": (await readFile(
        new URL("../app/lib/github/repository-manifest.ts", import.meta.url), "utf8",
      ))
        .replace('from "../ingestion/document-source.js"', 'from "./document-source.mjs"')
        .replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"')
        .replace('from "../markdown/validate-markdown.js"', 'from "./validate-markdown.mjs"')
        .replace('from "./discovery-contracts.js"', 'from "./discovery-contracts.mjs"'),
      "discovery-contracts.mjs": (await readFile(
        new URL("../app/lib/github/discovery-contracts.ts", import.meta.url), "utf8",
      )).replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"'),
      "document-source.mjs": (await readFile(
        new URL("../app/lib/ingestion/document-source.ts", import.meta.url), "utf8",
      )).replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"'),
      "normalize.mjs": await readFile(
        new URL("../app/lib/markdown/normalize.ts", import.meta.url), "utf8",
      ),
      "validate-markdown.mjs": await readFile(
        new URL("../app/lib/markdown/validate-markdown.ts", import.meta.url), "utf8",
      ),
    };
    await Promise.all(Object.entries(files).map(([name, source]) =>
      writeFile(join(directory, name), transpile(source))));
    const [incremental, contracts] = await Promise.all([
      import(pathToFileURL(join(directory, "incremental-sync.mjs")).href),
      import(pathToFileURL(join(directory, "source-job-contracts.mjs")).href),
    ]);
    return {
      incremental,
      contracts,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulesPromise;
}

const timestamp = "2026-08-07T10:00:00.000Z";

function manifest({ repositoryId, commitSha, blobSha, files = true }) {
  return {
    repositoryId,
    owner: "coreline-ai",
    repositoryName: `repository-${repositoryId}`,
    defaultBranch: "main",
    commitSha,
    status: "ready",
    treeStrategy: "recursive",
    files: files ? [{
      repositoryId,
      path: "README.md",
      role: "readme",
      blobSha,
      size: 100,
      sourceKey: `github:${repositoryId}:README.md`,
      rawUrl: `https://raw.githubusercontent.com/coreline-ai/repository-${repositoryId}/${commitSha}/README.md`,
      sourceUrl: `https://github.com/coreline-ai/repository-${repositoryId}/blob/${commitSha}/README.md`,
    }] : [],
    skipped: [],
    digest: repositoryId.padStart(64, "0").slice(-64),
  };
}

async function previewJob(contracts, {
  repositoryId,
  runId,
  commitSha,
  blobSha,
  manifestDigest,
  files = true,
  status = "completed",
  errorCode,
}) {
  const input = await contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    owner: "coreline-ai",
    selectedRepositoryIds: [repositoryId],
    requestNonce: `${runId}:${repositoryId}`,
    syncTrigger: "manual",
    syncRunId: runId,
  });
  const repository = manifest({ repositoryId, commitSha, blobSha, files });
  return {
    id: input.jobId,
    idempotencyKey: input.idempotencyKey,
    kind: "preview",
    owner: "coreline-ai",
    status,
    input,
    result: status === "completed" ? {
      jobId: input.jobId,
      idempotencyKey: input.idempotencyKey,
      kind: "preview",
      status: "completed",
      summary: {},
      capability: {},
      preview: {
        status: "ready",
        selectedRepositoryIds: [repositoryId],
        selectionDigest: "f".repeat(64),
        manifestDigest,
        repositories: [repository],
        totals: {},
        generatedAt: timestamp,
      },
    } : undefined,
    attemptCount: 1,
    maxAttempts: 3,
    manualRetryCount: 0,
    errorCode,
    errorMessage: errorCode ? "저장소 접근 실패" : undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: status === "completed" || status === "failed" ? timestamp : undefined,
  };
}

test("증분 요청은 수동 Apply 승인과 공통 trigger/run 계약을 강제한다", async () => {
  const { incremental, contracts } = await incrementalModules();
  const preview = incremental.parseGitHubIncrementalSyncRequest({
    action: "preview",
    trigger: "webhook",
    repositoryIds: ["20", "10", "20"],
    runId: "webhook-20260807",
  });
  assert.deepEqual(preview.repositoryIds, ["10", "20"]);
  assert.equal(preview.trigger, "webhook");

  await assert.rejects(contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    selectedRepositoryIds: ["10"],
    syncTrigger: "manual",
  }), /함께 제공/);
  await assert.rejects(contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    selectedRepositoryIds: ["10"],
    syncTrigger: "timer",
    syncRunId: "run-1",
  }), /trigger/);
  assert.throws(() => incremental.parseGitHubIncrementalSyncRequest({
    action: "apply",
    trigger: "schedule",
    repositoryIds: ["10"],
    runId: "scheduled-apply",
    approvedPreviewJobIds: [`github-source:preview:${"a".repeat(40)}`],
  }), /수동 승인/);
  assert.throws(() => incremental.parseGitHubIncrementalSyncRequest({
    action: "apply",
    repositoryIds: ["10", "20"],
    runId: "manual-apply",
    approvedPreviewJobIds: [`github-source:preview:${"a".repeat(40)}`],
  }), /하나씩/);
});

test("마지막 성공 commit·manifest와 dry-run으로 no-op·create·update·delete를 구분한다", async () => {
  const { incremental, contracts } = await incrementalModules();
  const runId = "incremental-diff";
  const sameDigest = "a".repeat(64);
  const jobs = await Promise.all([
    previewJob(contracts, {
      repositoryId: "10", runId, commitSha: "1".repeat(40), blobSha: "2".repeat(40), manifestDigest: sameDigest,
    }),
    previewJob(contracts, {
      repositoryId: "20", runId, commitSha: "3".repeat(40), blobSha: "4".repeat(40), manifestDigest: "b".repeat(64),
    }),
    previewJob(contracts, {
      repositoryId: "30", runId, commitSha: "5".repeat(40), blobSha: "6".repeat(40), manifestDigest: "c".repeat(64),
    }),
    previewJob(contracts, {
      repositoryId: "40", runId, commitSha: "7".repeat(40), blobSha: "8".repeat(40), manifestDigest: "d".repeat(64), files: false,
    }),
  ]);
  const currentDocuments = [
    { repositoryId: "10", sourceKey: "github:10:README.md", relativePath: "README.md", blobSha: "2".repeat(40) },
    { repositoryId: "20", sourceKey: "github:20:README.md", relativePath: "README.md", blobSha: "0".repeat(40) },
    { repositoryId: "40", sourceKey: "github:40:README.md", relativePath: "README.md", blobSha: "9".repeat(40) },
  ];
  const storedRepositories = [
    { repositoryId: "10", repositoryOwner: "coreline-ai", repositoryName: "repository-10", documentCount: 1, nodeCount: 2, edgeCount: 1, commitSha: "1".repeat(40), manifestDigest: sameDigest, lastSyncedAt: timestamp },
    { repositoryId: "20", repositoryOwner: "coreline-ai", repositoryName: "repository-20", documentCount: 1, nodeCount: 2, edgeCount: 1, commitSha: "0".repeat(40), manifestDigest: "0".repeat(64), lastSyncedAt: timestamp },
    { repositoryId: "40", repositoryOwner: "coreline-ai", repositoryName: "repository-40", documentCount: 1, nodeCount: 2, edgeCount: 1, commitSha: "0".repeat(40), manifestDigest: "0".repeat(64), lastSyncedAt: timestamp },
  ];
  const report = incremental.projectGitHubIncrementalRun({
    runId,
    trigger: "manual",
    repositoryIds: ["10", "20", "30", "40"],
    jobs,
    storedRepositories,
    currentDocuments,
  });
  const byId = new Map(report.repositories.map((item) => [item.repositoryId, item]));
  assert.equal(byId.get("10").status, "unchanged");
  assert.equal(byId.get("10").commitChanged, false);
  assert.equal(byId.get("10").manifestChanged, false);
  assert.equal(byId.get("20").dryRun.summary.updateCount, 1);
  assert.equal(byId.get("30").dryRun.summary.createCount, 1);
  assert.equal(byId.get("40").dryRun.summary.deleteCount, 1);
  assert.equal(report.totals.unchanged, 1);
  assert.equal(report.totals.changed, 3);
});

test("저장소별 권한 실패를 격리하고 이전 성공 상태와 재시도 영수증을 보존한다", async () => {
  const { incremental, contracts } = await incrementalModules();
  const runId = "incremental-isolation";
  const jobs = await Promise.all([
    previewJob(contracts, {
      repositoryId: "50", runId, commitSha: "1".repeat(40), blobSha: "2".repeat(40), manifestDigest: "a".repeat(64), status: "failed", errorCode: "github_forbidden",
    }),
    previewJob(contracts, {
      repositoryId: "60", runId, commitSha: "3".repeat(40), blobSha: "4".repeat(40), manifestDigest: "b".repeat(64),
    }),
  ]);
  const report = incremental.projectGitHubIncrementalRun({
    runId,
    trigger: "manual",
    repositoryIds: ["50", "60"],
    jobs,
    storedRepositories: [{
      repositoryId: "50",
      repositoryOwner: "coreline-ai",
      repositoryName: "repository-50",
      documentCount: 4,
      nodeCount: 30,
      edgeCount: 20,
      commitSha: "9".repeat(40),
      manifestDigest: "9".repeat(64),
      lastSyncedAt: "2026-08-06T00:00:00.000Z",
    }],
    currentDocuments: [],
  });
  const failed = report.repositories.find((item) => item.repositoryId === "50");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "github_forbidden");
  assert.equal(failed.lastSuccessful.commitSha, "9".repeat(40));
  assert.deepEqual(failed.retry, {
    jobId: failed.previewJobId,
    manualRetryCount: 0,
    maxManualRetries: 2,
    available: true,
  });
  assert.equal(report.repositories.find((item) => item.repositoryId === "60").status, "changed");
  assert.equal(report.totals.failed, 1);
  assert.equal(report.totals.changed, 1);
});

test.after(async () => {
  if (modulesPromise) await (await modulesPromise).cleanup();
});
