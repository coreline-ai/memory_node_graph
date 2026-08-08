import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

let modulesPromise;

async function enrichmentModules() {
  modulesPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-enrichment-test-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;

    const contractsSource = await readFile(
      new URL("../app/lib/llm/enrichment-contracts.ts", import.meta.url),
      "utf8",
    );
    const repositorySource = (
      await readFile(
        new URL("../app/lib/storage/enrichment-job-repository.ts", import.meta.url),
        "utf8",
      )
    )
      .replace('from "../llm/enrichment-contracts"', 'from "./enrichment-contracts.mjs"')
      .replace('from "../markdown/normalize"', 'from "./normalize.mjs"');
    const normalizeSource = await readFile(
      new URL("../app/lib/markdown/normalize.ts", import.meta.url),
      "utf8",
    );

    await Promise.all([
      writeFile(join(directory, "enrichment-contracts.mjs"), transpile(contractsSource)),
      writeFile(join(directory, "enrichment-job-repository.mjs"), transpile(repositorySource)),
      writeFile(join(directory, "normalize.mjs"), transpile(normalizeSource)),
    ]);
    const [contracts, repository] = await Promise.all([
      import(pathToFileURL(join(directory, "enrichment-contracts.mjs")).href),
      import(pathToFileURL(join(directory, "enrichment-job-repository.mjs")).href),
    ]);
    return { contracts, repository, cleanup: () => rm(directory, { recursive: true, force: true }) };
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
    this.failNextCompletionBatch = false;
    this.database.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE relations (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source_id TEXT NOT NULL,
        target_id TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL,
        note TEXT NOT NULL, origin TEXT NOT NULL, provider TEXT,
        provider_version TEXT, prompt_version TEXT, evidence_json TEXT, created_at TEXT
      );
    `);
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        if (
          this.failNextCompletionBatch &&
          statement.sql.includes("UPDATE enrichment_jobs") &&
          statement.sql.includes("result_json")
        ) {
          this.failNextCompletionBatch = false;
          throw new Error("fault injection: completion update");
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

  setDocumentHash(id, hash) {
    this.database.prepare("INSERT OR REPLACE INTO documents (id, hash) VALUES (?, ?)").run(id, hash);
  }
}

const baseNode = (index) => ({
  id: `node-${index}`,
  label: `노드 ${index}`,
  shortLabel: `N${index}`,
  kind: "concept",
  domain: "memory",
  summary: "테스트 노드",
  insight: "테스트",
  tags: ["test"],
});

async function makeInput(
  contracts,
  documentHash = "hash-v1",
  documentId = "document-1",
  providerVersion = "codex-sdk-0.146.0",
) {
  return contracts.buildEnrichmentJobInput({
    document: {
      id: documentId,
      name: `${documentId}.md`,
      hash: documentHash,
      parserVersion: "markdown-ast-v1",
    },
    providerVersion,
    nodes: [baseNode(1), baseNode(2)],
    existingRelations: [],
    blocks: [
      { id: `block:${documentId}:0`, type: "heading", depth: 1, text: "지식 그래프", ordinal: 0 },
    ],
  });
}

const resultFor = (input) => ({
  jobId: input.jobId,
  idempotencyKey: input.idempotencyKey,
  documentHash: input.document.hash,
  provider: "codex",
  providerVersion: input.providerVersion,
  promptVersion: input.promptVersion,
  status: "completed",
  relations: [],
  warnings: [],
});

test("enrichment input applies deterministic idempotency and evidence caps", async () => {
  const { contracts } = await enrichmentModules();
  const blocks = Array.from({ length: 140 }, (_, ordinal) => ({
    id: `block:${ordinal}`,
    type: "paragraph",
    depth: 0,
    text: `  근거 ${ordinal}  ${"가".repeat(1_400)}  `,
    ordinal,
  }));
  const base = {
    document: { id: "doc", name: "doc.md", hash: "same-hash", parserVersion: "parser-v1" },
    providerVersion: "provider-v1",
    nodes: Array.from({ length: 230 }, (_, index) => baseNode(index)),
    existingRelations: [],
    blocks,
  };

  const first = await contracts.buildEnrichmentJobInput(base);
  const duplicate = await contracts.buildEnrichmentJobInput(base);
  const changed = await contracts.buildEnrichmentJobInput({ ...base, providerVersion: "provider-v2" });
  const forced = await contracts.buildEnrichmentJobInput({ ...base, reprocessNonce: "manual-reindex-1" });
  const forcedDuplicate = await contracts.buildEnrichmentJobInput({ ...base, reprocessNonce: "manual-reindex-1" });

  assert.equal(first.idempotencyKey, duplicate.idempotencyKey);
  assert.notEqual(first.idempotencyKey, changed.idempotencyKey);
  assert.notEqual(first.idempotencyKey, forced.idempotencyKey);
  assert.equal(forced.idempotencyKey, forcedDuplicate.idempotencyKey);
  assert.equal(first.jobId, duplicate.jobId);
  assert.equal(first.nodes.length, contracts.ENRICHMENT_INPUT_LIMITS.maxNodes);
  assert.ok(first.evidenceBlocks.length <= contracts.ENRICHMENT_INPUT_LIMITS.maxEvidenceBlocks);
  assert.ok(first.evidenceBlocks.every((block) => block.text.length <= 1_200));
  assert.ok(
    first.evidenceBlocks.reduce((sum, block) => sum + block.text.length, 0) <=
      contracts.ENRICHMENT_INPUT_LIMITS.maxEvidenceCharacters,
  );
});

test("forced reindex invalidates matching-hash enrichment jobs before enqueueing a replacement", async () => {
  const { contracts, repository } = await enrichmentModules();
  const memory = repository.createMemoryEnrichmentJobRepository();
  const sqlite = new SqliteD1Database();
  try {
    const d1 = repository.createD1EnrichmentJobRepository(sqlite);
    for (const candidate of [memory, d1]) {
      const input = await makeInput(contracts, "force-hash", `force-${candidate === memory ? "memory" : "d1"}`);
      await candidate.enqueue(input, { now: "2026-08-04T00:00:00.000Z" });
      assert.equal(
        await candidate.markDocumentStale(
          input.document.id,
          input.document.hash,
          "2026-08-04T00:00:01.000Z",
          true,
        ),
        1,
      );
      assert.equal((await candidate.get(input.jobId)).status, "stale");
    }
  } finally {
    sqlite.close();
  }
});

test("통합 런타임 claim은 현재 provider 버전만 가져오고 기존 대기열을 보존한다", async () => {
  const { contracts, repository } = await enrichmentModules();
  const memory = repository.createMemoryEnrichmentJobRepository();
  const sqlite = new SqliteD1Database();
  try {
    const d1 = repository.createD1EnrichmentJobRepository(sqlite);
    for (const candidate of [memory, d1]) {
      const suffix = candidate === memory ? "memory" : "d1";
      const legacy = await makeInput(contracts, "legacy-hash", `legacy-${suffix}`, "codex-sdk-0.146.0");
      const integrated = await makeInput(
        contracts,
        "runtime-hash",
        `runtime-${suffix}`,
        "codex-sdk-0.146.0+atlas-runtime.1",
      );
      await candidate.enqueue(legacy, { now: "2026-08-08T00:00:00.000Z" });
      await candidate.enqueue(integrated, { now: "2026-08-08T00:00:01.000Z" });
      assert.equal((await candidate.statusCounts()).queued, 2);
      assert.equal(
        (await candidate.statusCounts("codex-sdk-0.146.0+atlas-runtime.1")).queued,
        1,
      );
      const claimed = await candidate.claim({
        runtimeId: "atlas-runtime-test",
        providerVersion: "codex-sdk-0.146.0+atlas-runtime.1",
        now: "2026-08-08T00:00:02.000Z",
      });
      assert.equal(claimed.id, integrated.jobId);
      assert.equal((await candidate.get(legacy.jobId)).status, "queued");
    }
  } finally {
    sqlite.close();
  }
});

async function exerciseRepository(repository, contracts, setDocumentHash = () => {}) {
  const trace = [];
  const input = await makeInput(contracts);
  setDocumentHash(input.document.id, input.document.hash);
  const first = await repository.enqueue(input, { now: "2026-08-02T00:00:00.000Z" });
  const duplicate = await repository.enqueue(input, { now: "2026-08-02T00:00:01.000Z" });
  trace.push(first.created, duplicate.created, (await repository.list()).length);

  const leased = await repository.claim({
    runtimeId: "runtime-a",
    leaseDurationMs: 1_000,
    now: "2026-08-02T00:00:02.000Z",
  });
  trace.push(leased.status, leased.attemptCount);

  await assert.rejects(
    repository.renewLease({
      jobId: input.jobId,
      runtimeId: "runtime-b",
      now: "2026-08-02T00:00:02.100Z",
    }),
    (error) => error.code === "lease_conflict",
  );
  await assert.rejects(
    repository.complete({
      jobId: input.jobId,
      runtimeId: "runtime-b",
      currentDocumentHash: input.document.hash,
      result: resultFor(input),
      now: "2026-08-02T00:00:02.200Z",
    }),
    (error) => error.code === "lease_conflict",
  );

  const blocked = await repository.claim({
    runtimeId: "runtime-b",
    now: "2026-08-02T00:00:02.500Z",
  });
  trace.push(blocked);
  const reclaimed = await repository.claim({
    runtimeId: "runtime-b",
    now: "2026-08-02T00:00:03.001Z",
  });
  trace.push(reclaimed.status, reclaimed.leaseOwner, reclaimed.attemptCount);
  await repository.markRunning({
    jobId: input.jobId,
    runtimeId: "runtime-b",
    now: "2026-08-02T00:00:03.100Z",
  });
  setDocumentHash(input.document.id, "hash-v2");
  const stale = await repository.complete({
    jobId: input.jobId,
    runtimeId: "runtime-b",
    currentDocumentHash: "hash-v2",
    result: resultFor(input),
    now: "2026-08-02T00:00:03.200Z",
  });
  trace.push(stale.status, stale.errorCode, Boolean(stale.result));

  const retryInput = await makeInput(contracts, "hash-retry", "document-retry");
  await repository.enqueue(retryInput, {
    now: "2026-08-02T00:00:04.000Z",
    maxAttempts: 2,
  });
  await repository.claim({ runtimeId: "runtime-a", now: "2026-08-02T00:00:04.100Z" });
  const requeued = await repository.fail({
    jobId: retryInput.jobId,
    runtimeId: "runtime-a",
    errorCode: "provider_timeout",
    errorMessage: "retry",
    retryable: true,
    now: "2026-08-02T00:00:04.200Z",
  });
  trace.push(requeued.status);
  await repository.claim({ runtimeId: "runtime-a", now: "2026-08-02T00:00:04.300Z" });
  const failed = await repository.fail({
    jobId: retryInput.jobId,
    runtimeId: "runtime-a",
    errorCode: "provider_timeout",
    errorMessage: "stop",
    retryable: true,
    now: "2026-08-02T00:00:04.400Z",
  });
  trace.push(failed.status, failed.attemptCount);

  const cancelInput = await makeInput(contracts, "hash-cancel", "document-cancel");
  await repository.enqueue(cancelInput, { now: "2026-08-02T00:00:05.000Z" });
  trace.push((await repository.cancel(cancelInput.jobId, "2026-08-02T00:00:05.100Z")).status);

  const completedInput = await makeInput(contracts, "hash-complete", "document-complete");
  setDocumentHash(completedInput.document.id, completedInput.document.hash);
  await repository.enqueue(completedInput, { now: "2026-08-02T00:00:06.000Z" });
  await repository.claim({ runtimeId: "runtime-a", now: "2026-08-02T00:00:06.100Z" });
  const completed = await repository.complete({
    jobId: completedInput.jobId,
    runtimeId: "runtime-a",
    currentDocumentHash: completedInput.document.hash,
    result: resultFor(completedInput),
    now: "2026-08-02T00:00:06.200Z",
  });
  trace.push(completed.status, Boolean(completed.result));
  trace.push(await repository.markDocumentStale(
    completedInput.document.id,
    "replacement-hash",
    "2026-08-02T00:00:06.300Z",
  ));
  trace.push((await repository.get(completedInput.jobId)).status);
  return trace;
}

test("memory and D1 repositories share idempotency, lease, retry, cancel, and stale transitions", async () => {
  const { contracts, repository } = await enrichmentModules();
  const memory = repository.createMemoryEnrichmentJobRepository();
  const sqlite = new SqliteD1Database();
  try {
    const d1 = repository.createD1EnrichmentJobRepository(sqlite);
    const memoryTrace = await exerciseRepository(memory, contracts);
    const d1Trace = await exerciseRepository(d1, contracts, (id, hash) => sqlite.setDocumentHash(id, hash));
    assert.deepEqual(d1Trace, memoryTrace);
    assert.deepEqual(memoryTrace, [
      true, false, 1,
      "leased", 1,
      null,
      "leased", "runtime-b", 2,
      "stale", "document_stale", false,
      "queued",
      "failed", 2,
      "cancelled",
      "completed", true,
      1,
      "stale",
    ]);
  } finally {
    sqlite.close();
  }
});

test("D1 result merge rolls back relations when completion update fails", async () => {
  const { contracts, repository } = await enrichmentModules();
  const sqlite = new SqliteD1Database();
  try {
    const d1 = repository.createD1EnrichmentJobRepository(sqlite);
    const input = await makeInput(contracts, "hash-atomic", "document-atomic");
    sqlite.setDocumentHash(input.document.id, input.document.hash);
    await d1.enqueue(input, { now: "2026-08-02T01:00:00.000Z" });
    await d1.claim({ runtimeId: "runtime-a", now: "2026-08-02T01:00:00.100Z" });
    await d1.markRunning({
      jobId: input.jobId,
      runtimeId: "runtime-a",
      now: "2026-08-02T01:00:00.200Z",
    });
    const result = {
      ...resultFor(input),
      relations: [{
        source: "node-1",
        target: "node-2",
        type: "supports",
        confidence: 0.9,
        note: "원자적 병합 테스트",
        evidence: [{ blockId: `block:${input.document.id}:0`, explanation: "테스트 근거" }],
      }],
    };

    sqlite.failNextCompletionBatch = true;
    await assert.rejects(
      d1.complete({
        jobId: input.jobId,
        runtimeId: "runtime-a",
        currentDocumentHash: input.document.hash,
        result,
        now: "2026-08-02T01:00:00.300Z",
      }),
      /fault injection/,
    );
    assert.equal(sqlite.database.prepare("SELECT COUNT(*) AS count FROM relations").get().count, 0);
    assert.equal((await d1.get(input.jobId)).status, "running");

    const completed = await d1.complete({
      jobId: input.jobId,
      runtimeId: "runtime-a",
      currentDocumentHash: input.document.hash,
      result,
      now: "2026-08-02T01:00:00.400Z",
    });
    assert.equal(completed.status, "completed");
    assert.equal(sqlite.database.prepare("SELECT COUNT(*) AS count FROM relations").get().count, 1);
  } finally {
    sqlite.close();
  }
});

test("겹침 청크의 동일 관계는 confidence와 evidence를 유실 없이 병합한다", async () => {
  const { contracts, repository } = await enrichmentModules();
  const sqlite = new SqliteD1Database();
  try {
    const d1 = repository.createD1EnrichmentJobRepository(sqlite);
    const firstInput = await makeInput(contracts, "hash-chunk-merge", "document-chunk-merge");
    const secondInput = {
      ...structuredClone(firstInput),
      jobId: `${firstInput.jobId}-second`,
      idempotencyKey: `${firstInput.idempotencyKey}-second`,
      chunk: { ...firstInput.chunk, index: 1, count: 2, key: "chunk:2:2:1-1" },
    };
    sqlite.setDocumentHash(firstInput.document.id, firstInput.document.hash);
    await d1.enqueue(firstInput, { now: "2026-08-02T01:10:00.000Z" });
    await d1.enqueue(secondInput, { now: "2026-08-02T01:10:00.010Z" });

    for (const [index, input] of [firstInput, secondInput].entries()) {
      await d1.claim({ runtimeId: "runtime-a", now: `2026-08-02T01:10:0${index}.100Z` });
      await d1.complete({
        jobId: input.jobId,
        runtimeId: "runtime-a",
        currentDocumentHash: input.document.hash,
        result: {
          ...resultFor(input),
          relations: [{
            source: "node-1",
            target: "node-2",
            type: "supports",
            confidence: index === 0 ? 0.72 : 0.94,
            note: index === 0 ? "첫 청크" : "두 번째 청크의 더 자세한 관계 설명",
            evidence: [{
              blockId: `block:${input.document.id}:${index}`,
              explanation: `청크 ${index + 1} 근거`,
            }],
          }],
        },
        now: `2026-08-02T01:10:0${index}.200Z`,
      });
    }

    const rows = sqlite.database.prepare("SELECT * FROM relations").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].confidence, 0.94);
    assert.equal(rows[0].note, "두 번째 청크의 더 자세한 관계 설명");
    assert.deepEqual(JSON.parse(rows[0].evidence_json).map((item) => item.explanation), [
      "청크 1 근거",
      "청크 2 근거",
    ]);
  } finally {
    sqlite.close();
  }
});

test("D1 warning retry atomically removes the previous Codex relations", async () => {
  const { contracts, repository } = await enrichmentModules();
  const sqlite = new SqliteD1Database();
  try {
    const d1 = repository.createD1EnrichmentJobRepository(sqlite);
    const input = await makeInput(contracts, "hash-warning-retry", "document-warning-retry");
    sqlite.setDocumentHash(input.document.id, input.document.hash);
    await d1.enqueue(input, { now: "2026-08-02T01:30:00.000Z" });
    await d1.claim({ runtimeId: "runtime-a", now: "2026-08-02T01:30:00.100Z" });
    const warning = await d1.complete({
      jobId: input.jobId,
      runtimeId: "runtime-a",
      currentDocumentHash: input.document.hash,
      result: {
        ...resultFor(input),
        status: "warning",
        warnings: ["fixture warning"],
        relations: [{
          source: "node-1",
          target: "node-2",
          type: "supports",
          confidence: 0.8,
          note: "재시도 전 관계",
          evidence: [{ blockId: `block:${input.document.id}:0`, explanation: "테스트 근거" }],
        }],
      },
      now: "2026-08-02T01:30:00.200Z",
    });
    assert.equal(warning.status, "warning");
    assert.equal(sqlite.database.prepare("SELECT COUNT(*) AS count FROM relations").get().count, 1);

    const retried = await d1.retry(input.jobId, "2026-08-02T01:30:00.300Z");
    assert.equal(retried.status, "queued");
    assert.equal(retried.manualRetryCount, 1);
    assert.equal(sqlite.database.prepare("SELECT COUNT(*) AS count FROM relations").get().count, 0);
  } finally {
    sqlite.close();
  }
});

async function exerciseManualRetryAndHeartbeat(repository, contracts) {
  const input = await makeInput(contracts, "hash-manual-retry", "document-manual-retry");
  await repository.enqueue(input, { now: "2026-08-02T02:00:00.000Z", maxAttempts: 1 });

  for (let retry = 1; retry <= 2; retry += 1) {
    await repository.claim({ runtimeId: "runtime-a", now: `2026-08-02T02:00:0${retry}.000Z` });
    await repository.fail({
      jobId: input.jobId,
      runtimeId: "runtime-a",
      errorCode: "provider_error",
      errorMessage: "manual retry fixture",
      retryable: false,
      now: `2026-08-02T02:00:0${retry}.100Z`,
    });
    const queued = await repository.retry(input.jobId, `2026-08-02T02:00:0${retry}.200Z`);
    assert.equal(queued.status, "queued");
    assert.equal(queued.manualRetryCount, retry);
    assert.equal(queued.attemptCount, 0);
  }

  await repository.claim({ runtimeId: "runtime-a", now: "2026-08-02T02:00:10.000Z" });
  await repository.fail({
    jobId: input.jobId,
    runtimeId: "runtime-a",
    errorCode: "provider_error",
    errorMessage: "retry exhausted fixture",
    retryable: false,
    now: "2026-08-02T02:00:10.100Z",
  });
  await assert.rejects(
    repository.retry(input.jobId, "2026-08-02T02:00:10.200Z"),
    (error) => error.code === "retry_exhausted",
  );

  await repository.recordRuntimeStatus({
    runtimeId: "runtime-heartbeat",
    status: "online",
    version: "test-v1",
    currentJobId: input.jobId,
    now: "2026-08-02T02:01:00.000Z",
  });
  const offline = await repository.recordRuntimeStatus({
    runtimeId: "runtime-heartbeat",
    status: "offline",
    version: "test-v1",
    runMode: "bounded",
    maxJobs: 2,
    maxRuntimeMs: 300_000,
    processedJobs: 2,
    succeededJobs: 1,
    warningJobs: 1,
    failedJobs: 0,
    stopReason: "job_limit",
    now: "2026-08-02T02:01:10.000Z",
  });
  assert.equal(offline.status, "offline");
  assert.equal(offline.startedAt, "2026-08-02T02:01:00.000Z");
  assert.equal(offline.runMode, "bounded");
  assert.equal(offline.maxJobs, 2);
  assert.equal(offline.processedJobs, 2);
  assert.equal(offline.warningJobs, 1);
  assert.equal(offline.stopReason, "job_limit");
  const heartbeats = await repository.listRuntimeStatuses();
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].lastSeenAt, "2026-08-02T02:01:10.000Z");
}

test("manual retry is bounded and 통합 런타임 heartbeat is persisted in memory and D1", async () => {
  const { contracts, repository } = await enrichmentModules();
  const memory = repository.createMemoryEnrichmentJobRepository();
  const sqlite = new SqliteD1Database();
  try {
    await exerciseManualRetryAndHeartbeat(memory, contracts);
    await exerciseManualRetryAndHeartbeat(
      repository.createD1EnrichmentJobRepository(sqlite),
      contracts,
    );
  } finally {
    sqlite.close();
  }
});

test("기존 분리 실행 상태는 통합 runtime 상태 테이블로 안전하게 이관된다", async () => {
  const { repository } = await enrichmentModules();
  const sqlite = new SqliteD1Database();
  try {
    sqlite.database.exec(`
      CREATE TABLE connector_heartbeats (
        connector_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        version TEXT NOT NULL,
        current_job_id TEXT,
        started_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      INSERT INTO connector_heartbeats
        (connector_id, status, version, current_job_id, started_at, last_seen_at)
      VALUES
        ('legacy-runtime', 'online', 'legacy-v1', 'job-1',
         '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:10.000Z');
    `);
    const statuses = await repository.createD1EnrichmentJobRepository(sqlite).listRuntimeStatuses();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].runtimeId, "legacy-runtime");
    assert.equal(statuses[0].lastSeenAt, "2026-08-08T00:00:10.000Z");
  } finally {
    sqlite.close();
  }
});

test.after(async () => {
  const loaded = await modulesPromise;
  if (loaded) await loaded.cleanup();
});
