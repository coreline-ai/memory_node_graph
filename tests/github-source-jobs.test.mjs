import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

let modulesPromise;

async function sourceModules() {
  modulesPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-github-source-test-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const contracts = (
      await readFile(new URL("../app/lib/github/source-job-contracts.ts", import.meta.url), "utf8")
    )
      .replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"')
      .replace('from "./discovery-contracts.js"', 'from "./discovery-contracts.mjs"')
      .replace('from "./repository-manifest.js"', 'from "./repository-manifest.mjs"');
    const discoveryContracts = (
      await readFile(new URL("../app/lib/github/discovery-contracts.ts", import.meta.url), "utf8")
    ).replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"');
    const manifestContracts = (
      await readFile(new URL("../app/lib/github/repository-manifest.ts", import.meta.url), "utf8")
    )
      .replace('from "../ingestion/document-source.js"', 'from "./document-source.mjs"')
      .replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"')
      .replace('from "../markdown/validate-markdown.js"', 'from "./validate-markdown.mjs"')
      .replace('from "./discovery-contracts.js"', 'from "./discovery-contracts.mjs"');
    const documentSource = (
      await readFile(new URL("../app/lib/ingestion/document-source.ts", import.meta.url), "utf8")
    ).replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"');
    const validateMarkdown = await readFile(
      new URL("../app/lib/markdown/validate-markdown.ts", import.meta.url),
      "utf8",
    );
    const repository = (
      await readFile(
        new URL("../app/lib/storage/github-source-job-repository.ts", import.meta.url),
        "utf8",
      )
    ).replace('from "../github/source-job-contracts"', 'from "./source-job-contracts.mjs"');
    const normalize = await readFile(
      new URL("../app/lib/markdown/normalize.ts", import.meta.url),
      "utf8",
    );
    await Promise.all([
      writeFile(join(directory, "source-job-contracts.mjs"), transpile(contracts)),
      writeFile(join(directory, "discovery-contracts.mjs"), transpile(discoveryContracts)),
      writeFile(join(directory, "repository-manifest.mjs"), transpile(manifestContracts)),
      writeFile(join(directory, "document-source.mjs"), transpile(documentSource)),
      writeFile(join(directory, "validate-markdown.mjs"), transpile(validateMarkdown)),
      writeFile(join(directory, "github-source-job-repository.mjs"), transpile(repository)),
      writeFile(join(directory, "normalize.mjs"), transpile(normalize)),
    ]);
    const [contractModule, repositoryModule] = await Promise.all([
      import(pathToFileURL(join(directory, "source-job-contracts.mjs")).href),
      import(pathToFileURL(join(directory, "github-source-job-repository.mjs")).href),
    ]);
    return {
      contracts: contractModule,
      repository: repositoryModule,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulesPromise;
}

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
    this.database.exec(`
      CREATE TABLE enrichment_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO enrichment_jobs (id, status) VALUES ('enrichment-sentinel', 'queued');
    `);
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
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

const onlineReport = (checkedAt) => ({
  capability: "github-source",
  status: "online",
  accountLogin: "atlas-user",
  host: "github.com",
  checkedAt,
});

const completedResult = (job, checkedAt) => ({
  jobId: job.id,
  idempotencyKey: job.idempotencyKey,
  kind: job.kind,
  status: "completed",
  capability: onlineReport(checkedAt),
  summary: {
    discoveredCount: 117,
    selectedCount: 3,
    changedCount: 2,
    unchangedCount: 1,
    deletedCount: 0,
    failedCount: 0,
  },
});

test("GitHub source 요청은 결정적이며 자격 증명 필드와 값을 거부한다", async () => {
  const { contracts } = await sourceModules();
  const first = await contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    owner: "coreline-ai",
    selectedRepositoryIds: ["30", "10", "30"],
  });
  const duplicate = await contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    owner: "coreline-ai",
    selectedRepositoryIds: ["10", "30"],
  });
  assert.equal(first.idempotencyKey, duplicate.idempotencyKey);
  assert.deepEqual(first.selectedRepositoryIds, ["10", "30"]);
  assert.match(first.jobId, /^github-source:preview:[0-9a-f]{40}$/);
  const repeatedRun = await contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    owner: "coreline-ai",
    selectedRepositoryIds: ["10", "30"],
    requestNonce: "manual-run-2",
  });
  assert.notEqual(first.idempotencyKey, repeatedRun.idempotencyKey);
  const incrementalRun = await contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    owner: "coreline-ai",
    selectedRepositoryIds: ["10"],
    requestNonce: "incremental-run-1:10",
    syncTrigger: "webhook",
    syncRunId: "incremental-run-1",
  });
  assert.equal(incrementalRun.syncTrigger, "webhook");
  assert.equal(incrementalRun.syncRunId, "incremental-run-1");

  await assert.rejects(
    contracts.parseGitHubSourceJobRequest({ kind: "discovery", token: "not-stored" }),
    /자격 증명 필드/,
  );
  assert.doesNotThrow(() => contracts.assertCredentialFreePayload(
    "curl '/callback?access_token=<access_token>' && echo '${ACCESS_TOKEN}'",
  ));
  assert.doesNotThrow(() => contracts.assertCredentialFreePayload(
    "curl -H 'Authorization: Bearer local-dev-only' http://127.0.0.1:4317/health",
  ));
  assert.doesNotThrow(() => contracts.assertCredentialFreePayload(
    "Authorization: Bearer example-token; Authorization: Bearer Token; access_token=YOUR_ACCESS_TOKEN",
  ));
  assert.doesNotThrow(() => contracts.assertCredentialFreePayload(
    "export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx",
  ));
  assert.doesNotThrow(() => contracts.assertCredentialFreePayload(
    "redaction fixture: Authorization: Bearer xyz123abc...",
  ));
  assert.doesNotThrow(() => contracts.assertCredentialFreePayload(
    "audit JSONL round-trip + bearer redaction; API_TOKEN is a Bearer token.",
  ));
  assert.doesNotThrow(() => contracts.assertCredentialFreePayload(
    "forbidden patterns: `Bearer ...`, `access_token=...`",
  ));
  assert.throws(() => contracts.assertCredentialFreePayload(
    "access_token=concrete-oauth-value-1234567890",
  ), /자격 증명으로 보이는 값/);
  assert.throws(() => contracts.assertCredentialFreePayload(
    "Authorization: Bearer a1b2c3d4e5f6g7h8i9j0",
  ), /자격 증명으로 보이는 값/);
  await assert.rejects(
    contracts.parseGitHubSourceJobRequest({
      kind: "discovery",
      owner: "coreline-ai",
      note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    }),
    /자격 증명으로 보이는 값|허용되지 않은 필드/,
  );
  await assert.rejects(
    contracts.parseGitHubSourceJobRequest({
      kind: "apply",
      owner: "coreline-ai",
      selectedRepositoryIds: ["10"],
    }),
    /manifestDigest/,
  );
});

test("gh 미설치·로그아웃·권한·rate limit·통합 런타임 오프라인을 분리한다", async () => {
  const { contracts } = await sourceModules();
  assert.deepEqual(contracts.normalizeGitHubCapability({
    runtimeOnline: false,
    ghInstalled: true,
    authenticated: true,
    authorized: true,
  }), { status: "offline", errorCode: "runtime_unavailable" });
  assert.deepEqual(contracts.normalizeGitHubCapability({
    runtimeOnline: true,
    ghInstalled: false,
    authenticated: false,
    authorized: false,
  }), { status: "offline", errorCode: "gh_missing" });
  assert.deepEqual(contracts.normalizeGitHubCapability({
    runtimeOnline: true,
    ghInstalled: true,
    authenticated: false,
    authorized: false,
  }), { status: "login_required", errorCode: "gh_auth_required" });
  assert.deepEqual(contracts.normalizeGitHubCapability({
    runtimeOnline: true,
    ghInstalled: true,
    authenticated: true,
    authorized: false,
  }), { status: "forbidden", errorCode: "github_forbidden" });
  assert.deepEqual(contracts.normalizeGitHubCapability({
    runtimeOnline: true,
    ghInstalled: true,
    authenticated: true,
    authorized: true,
    rateLimited: true,
  }), { status: "rate_limited", errorCode: "github_rate_limited" });
  assert.deepEqual(contracts.normalizeGitHubCapability({
    runtimeOnline: true,
    ghInstalled: true,
    authenticated: true,
    authorized: true,
  }), { status: "online" });

  assert.throws(() => contracts.parseGitHubCapabilityReport({
    capability: "github-source",
    status: "online",
    errorCode: "gh_auth_required",
    checkedAt: "2026-08-04T00:00:00.000Z",
  }), /상태와 오류 코드/);
});

async function exerciseRepository(candidate, contracts) {
  const runtimeId = "github-source-runtime";
  const discoveryInput = await contracts.parseGitHubSourceJobRequest({
    kind: "discovery",
    owner: "coreline-ai",
  });
  const first = await candidate.enqueue(discoveryInput, {
    now: "2026-08-04T00:00:00.000Z",
    maxAttempts: 2,
  });
  const duplicate = await candidate.enqueue(discoveryInput, {
    now: "2026-08-04T00:00:01.000Z",
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(await candidate.claim({
    runtimeId,
    now: "2026-08-04T00:00:02.000Z",
  }), null);

  await candidate.recordRuntimeCapability({
    runtimeId,
    ...onlineReport("2026-08-04T00:00:02.000Z"),
    now: "2026-08-04T00:00:02.000Z",
  });
  const firstLease = await candidate.claim({
    runtimeId,
    leaseDurationMs: 2_000,
    now: "2026-08-04T00:00:03.000Z",
  });
  assert.equal(firstLease.status, "leased");
  assert.equal(firstLease.attemptCount, 1);
  await assert.rejects(candidate.markRunning({
    jobId: firstLease.id,
    runtimeId: "other-runtime",
    now: "2026-08-04T00:00:03.200Z",
  }), (error) => error.code === "lease_conflict");
  assert.equal((await candidate.markRunning({
    jobId: firstLease.id,
    runtimeId,
    now: "2026-08-04T00:00:03.300Z",
  })).status, "running");
  assert.equal((await candidate.fail({
    jobId: firstLease.id,
    runtimeId,
    errorCode: "runtime_unavailable",
    errorMessage: "일시적인 로컬 통합 런타임 중단",
    retryable: true,
    now: "2026-08-04T00:00:03.400Z",
  })).status, "queued");

  const secondLease = await candidate.claim({
    runtimeId,
    leaseDurationMs: 2_000,
    now: "2026-08-04T00:00:04.000Z",
  });
  await candidate.markRunning({
    jobId: secondLease.id,
    runtimeId,
    now: "2026-08-04T00:00:04.100Z",
  });
  const failed = await candidate.fail({
    jobId: secondLease.id,
    runtimeId,
    errorCode: "github_forbidden",
    errorMessage: "조직 저장소 읽기 권한이 없습니다.",
    retryable: false,
    now: "2026-08-04T00:00:04.200Z",
  });
  assert.equal(failed.status, "failed");
  const retried = await candidate.retry(failed.id, "2026-08-04T00:00:04.300Z");
  assert.equal(retried.status, "queued");
  assert.equal(retried.manualRetryCount, 1);
  const thirdLease = await candidate.claim({
    runtimeId,
    now: "2026-08-04T00:00:05.000Z",
  });
  assert.equal((await candidate.cancel(thirdLease.id, "2026-08-04T00:00:05.100Z")).status, "cancelled");

  const previewInput = await contracts.parseGitHubSourceJobRequest({
    kind: "preview",
    owner: "coreline-ai",
    selectedRepositoryIds: ["101", "102", "103"],
  });
  await candidate.enqueue(previewInput, { now: "2026-08-04T00:00:06.000Z" });
  const previewLease = await candidate.claim({
    runtimeId,
    now: "2026-08-04T00:00:06.100Z",
  });
  await candidate.markRunning({
    jobId: previewLease.id,
    runtimeId,
    now: "2026-08-04T00:00:06.200Z",
  });
  const completed = await candidate.complete({
    jobId: previewLease.id,
    runtimeId,
    result: completedResult(previewLease, "2026-08-04T00:00:06.250Z"),
    now: "2026-08-04T00:00:06.300Z",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.summary.discoveredCount, 117);

  const firstApplyInput = await contracts.parseGitHubSourceJobRequest({
    kind: "apply",
    owner: "coreline-ai",
    selectedRepositoryIds: ["999"],
    manifestDigest: "a".repeat(64),
    requestNonce: "active-apply-1",
  });
  const secondApplyInput = await contracts.parseGitHubSourceJobRequest({
    kind: "apply",
    owner: "coreline-ai",
    selectedRepositoryIds: ["999"],
    manifestDigest: "a".repeat(64),
    requestNonce: "active-apply-2",
  });
  const firstApply = await candidate.enqueue(firstApplyInput, { now: "2026-08-04T00:00:07.000Z" });
  const conflictingApply = await candidate.enqueue(secondApplyInput, { now: "2026-08-04T00:00:07.100Z" });
  assert.equal(firstApply.created, true);
  assert.equal(conflictingApply.created, false);
  assert.equal(conflictingApply.job.id, firstApply.job.id);
  const stageChunk = {
    jobId: firstApply.job.id,
    chunkIndex: 0,
    totalChunks: 1,
    checksum: "b".repeat(64),
    documents: [{
      repositoryId: "999",
      path: "README.md",
      blobSha: "c".repeat(40),
      size: 4,
      content: "# A\n",
    }],
  };
  await assert.rejects(candidate.putApplyStageChunk({
    ...stageChunk,
    chunkIndex: 1,
    totalChunks: 2,
  }), (error) => error.code === "invalid_result" && /순서대로/.test(error.message));
  assert.equal(await candidate.putApplyStageChunk(stageChunk), 1);
  assert.equal(await candidate.putApplyStageChunk(stageChunk), 1);
  assert.equal((await candidate.listApplyStageChunks(firstApply.job.id)).length, 1);
  await candidate.cancel(firstApply.job.id, "2026-08-04T00:00:07.200Z");
  assert.equal((await candidate.listApplyStageChunks(firstApply.job.id)).length, 0);
  const applyAfterCancel = await candidate.enqueue(secondApplyInput, { now: "2026-08-04T00:00:07.300Z" });
  assert.equal(applyAfterCancel.created, true);
  const leasedApply = await candidate.claim({ runtimeId, now: "2026-08-04T00:00:07.400Z" });
  await candidate.markRunning({ jobId: leasedApply.id, runtimeId, now: "2026-08-04T00:00:07.500Z" });
  const retryStage = { ...stageChunk, jobId: leasedApply.id, totalChunks: 2 };
  await candidate.putApplyStageChunk(retryStage);
  const queuedAgain = await candidate.fail({
    jobId: leasedApply.id,
    runtimeId,
    errorCode: "runtime_unavailable",
    errorMessage: "chunk 업로드 중 통합 런타임 종료",
    retryable: true,
    now: "2026-08-04T00:00:07.600Z",
  });
  assert.equal(queuedAgain.status, "queued");
  assert.equal((await candidate.listApplyStageChunks(leasedApply.id)).length, 1);
  const resumedApply = await candidate.claim({ runtimeId, now: "2026-08-04T00:00:07.700Z" });
  assert.equal(resumedApply.id, leasedApply.id);
  assert.equal(await candidate.putApplyStageChunk(retryStage), 1);
  assert.equal(await candidate.putApplyStageChunk({
    ...retryStage,
    chunkIndex: 1,
    checksum: "d".repeat(64),
    documents: [{
      repositoryId: "999",
      path: "dev-plan/resumed.md",
      blobSha: "e".repeat(40),
      size: 10,
      content: "# Resumed\n",
    }],
  }), 2);
  assert.equal((await candidate.listApplyStageChunks(leasedApply.id)).length, 2);
  await candidate.cancel(resumedApply.id, "2026-08-04T00:00:07.800Z");
  assert.equal((await candidate.listApplyStageChunks(leasedApply.id)).length, 0);

  const expiringInput = await contracts.parseGitHubSourceJobRequest({
    kind: "apply",
    owner: "coreline-ai",
    selectedRepositoryIds: ["998"],
    manifestDigest: "d".repeat(64),
    requestNonce: "lease-expiry-stage-recovery",
  });
  const expiring = await candidate.enqueue(expiringInput, {
    now: "2026-08-04T00:00:08.000Z",
    maxAttempts: 2,
  });
  const expiringLease = await candidate.claim({
    runtimeId,
    leaseDurationMs: 1_000,
    now: "2026-08-04T00:00:08.100Z",
  });
  await candidate.markRunning({
    jobId: expiringLease.id,
    runtimeId,
    now: "2026-08-04T00:00:08.200Z",
  });
  await candidate.putApplyStageChunk({ ...stageChunk, jobId: expiring.job.id });
  const reclaimed = await candidate.claim({
    runtimeId,
    leaseDurationMs: 1_000,
    now: "2026-08-04T00:00:09.200Z",
  });
  assert.equal(reclaimed.id, expiring.job.id);
  assert.equal(reclaimed.attemptCount, 2);
  assert.equal((await candidate.listApplyStageChunks(expiring.job.id)).length, 1);
  assert.equal(await candidate.claim({
    runtimeId,
    leaseDurationMs: 1_000,
    now: "2026-08-04T00:00:10.300Z",
  }), null);
  const exhausted = await candidate.get(expiring.job.id);
  assert.equal(exhausted.status, "failed");
  assert.equal(exhausted.errorCode, "retry_exhausted");
  assert.equal((await candidate.listApplyStageChunks(expiring.job.id)).length, 0);

  await assert.rejects(candidate.fail({
    jobId: "missing-job",
    runtimeId,
    errorCode: "unknown",
    errorMessage: "Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    retryable: false,
  }), /자격 증명으로 보이는 값/);

  return { discoveryInput, previewInput };
}

test("source queue의 lease·retry·cancel은 보강 큐와 분리되고 메모리/D1이 동일하게 동작한다", async () => {
  const { contracts, repository } = await sourceModules();
  await exerciseRepository(repository.createMemoryGitHubSourceJobRepository(), contracts);

  const sqlite = new SqliteD1Database();
  try {
    const d1 = repository.createD1GitHubSourceJobRepository(sqlite);
    await exerciseRepository(d1, contracts);
    const sentinel = sqlite.database.prepare(
      "SELECT status FROM enrichment_jobs WHERE id = 'enrichment-sentinel'",
    ).get();
    assert.equal(sentinel.status, "queued");

    const persisted = JSON.stringify({
      jobs: sqlite.database.prepare(
        "SELECT input_json, result_json, error_message FROM github_source_jobs ORDER BY created_at",
      ).all(),
      runtimeStatuses: sqlite.database.prepare(
        "SELECT * FROM github_runtime_status ORDER BY runtime_id",
      ).all(),
    });
    assert.doesNotMatch(persisted, /authorization|github_pat_|ghp_|access[_-]?token/i);
  } finally {
    sqlite.close();
  }
});

async function exerciseRuntimeGenerationBoundary(candidate, contracts) {
  const runtimeId = "github-runtime-boundary";
  const legacy = {
    ...(await contracts.parseGitHubSourceJobRequest({
      kind: "discovery",
      owner: "coreline-ai",
      requestNonce: "legacy-generation",
    })),
    jobId: "github-source:discovery:legacy-generation",
    idempotencyKey: "legacy-generation-key",
    runtimeVersion: undefined,
  };
  const integrated = await contracts.parseGitHubSourceJobRequest({
    kind: "discovery",
    owner: "coreline-ai",
    requestNonce: "integrated-generation",
  });
  await candidate.enqueue(legacy, { now: "2026-08-08T00:00:00.000Z" });
  await candidate.enqueue(integrated, { now: "2026-08-08T00:00:01.000Z" });
  await candidate.recordRuntimeCapability({
    runtimeId,
    ...onlineReport("2026-08-08T00:00:02.000Z"),
    now: "2026-08-08T00:00:02.000Z",
  });
  const claimed = await candidate.claim({
    runtimeId,
    runtimeVersion: contracts.INTEGRATED_GITHUB_RUNTIME_VERSION,
    now: "2026-08-08T00:00:03.000Z",
  });
  assert.equal(claimed.id, integrated.jobId);
  assert.equal(claimed.input.runtimeVersion, contracts.INTEGRATED_GITHUB_RUNTIME_VERSION);
  await candidate.cancel(claimed.id, "2026-08-08T00:00:04.000Z");
  const legacyClaim = await candidate.claim({
    runtimeId,
    now: "2026-08-08T00:00:05.000Z",
  });
  assert.equal(legacyClaim.id, legacy.jobId);
}

test("통합 GitHub runtime은 generation 없는 과거 작업을 자동 실행하지 않는다", async () => {
  const { contracts, repository } = await sourceModules();
  await exerciseRuntimeGenerationBoundary(
    repository.createMemoryGitHubSourceJobRepository(),
    contracts,
  );
  const sqlite = new SqliteD1Database();
  try {
    await exerciseRuntimeGenerationBoundary(
      repository.createD1GitHubSourceJobRepository(sqlite),
      contracts,
    );
  } finally {
    sqlite.close();
  }
});

test("기존 GitHub 상태는 통합 runtime 상태 테이블로 안전하게 이관된다", async () => {
  const { repository } = await sourceModules();
  const sqlite = new SqliteD1Database();
  try {
    sqlite.database.exec(`
      CREATE TABLE github_connector_capabilities (
        connector_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        account_login TEXT,
        host TEXT,
        rate_limit_reset_at TEXT,
        message TEXT,
        checked_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (connector_id, capability)
      );
      INSERT INTO github_connector_capabilities
        (connector_id, capability, status, account_login, host, message, checked_at, last_seen_at)
      VALUES
        ('legacy-runtime', 'github-source', 'online', 'coreline-ai', 'github.com', 'ready',
         '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:10.000Z');
    `);
    const capabilities = await repository.createD1GitHubSourceJobRepository(sqlite)
      .listRuntimeCapabilities();
    assert.equal(capabilities.length, 1);
    assert.equal(capabilities[0].runtimeId, "legacy-runtime");
    assert.equal(capabilities[0].accountLogin, "coreline-ai");
  } finally {
    sqlite.close();
  }
});
