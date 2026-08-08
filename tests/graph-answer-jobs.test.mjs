import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

let modulesPromise;

async function graphAnswerModules() {
  modulesPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-answer-test-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const contracts = await readFile(
      new URL("../app/lib/llm/graph-answer-contracts.ts", import.meta.url),
      "utf8",
    );
    const validator = (await readFile(
      new URL("../app/lib/llm/graph-answer-result-validator.ts", import.meta.url),
      "utf8",
    )).replace('from "./graph-answer-contracts.js"', 'from "./graph-answer-contracts.mjs"');
    const repository = (await readFile(
      new URL("../app/lib/storage/graph-answer-job-repository.ts", import.meta.url),
      "utf8",
    )).replace('from "../llm/graph-answer-contracts"', 'from "./graph-answer-contracts.mjs"');
    await Promise.all([
      writeFile(join(directory, "graph-answer-contracts.mjs"), transpile(contracts)),
      writeFile(join(directory, "graph-answer-result-validator.mjs"), transpile(validator)),
      writeFile(join(directory, "graph-answer-job-repository.mjs"), transpile(repository)),
    ]);
    const [contractModule, validatorModule, repositoryModule] = await Promise.all([
      import(pathToFileURL(join(directory, "graph-answer-contracts.mjs")).href),
      import(pathToFileURL(join(directory, "graph-answer-result-validator.mjs")).href),
      import(pathToFileURL(join(directory, "graph-answer-job-repository.mjs")).href),
    ]);
    return {
      contracts: contractModule,
      validator: validatorModule,
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
  bind(...bindings) { return new SqliteD1Statement(this.database, this.sql, bindings); }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } };
  }
}

class SqliteD1Database {
  constructor() { this.database = new DatabaseSync(":memory:"); }
  prepare(sql) { return new SqliteD1Statement(this.database, sql); }
  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
  close() { this.database.close(); }
}

const retrieval = (now = "2026-08-07T00:00:00.000Z") => ({
  query: { original: "에이전트 기억", normalized: "에이전트 기억", terms: ["에이전트", "기억"] },
  context: {
    nodes: [{
      id: "node-memory",
      label: "에이전트 기억",
      shortLabel: "기억",
      kind: "concept",
      domain: "memory",
      summary: "작업 결과를 저장합니다.",
      insight: "재사용 가능한 기억이 반복 비용을 줄입니다.",
      tags: ["memory"],
      retrieval: { score: 1, hop: 0, matchedTerms: ["기억"], degree: 1, centrality: 1, evidenceCount: 1 },
    }],
    relations: [],
    citations: [{
      id: "block-memory-1",
      documentId: "document-memory",
      fileName: "README.md",
      text: "에이전트 기억은 검증된 작업 결과를 저장하고 다시 검색합니다.",
      sourceUrl: "https://example.com/README.md#L10",
      nodeIds: ["node-memory"],
    }],
  },
  meta: {
    algorithm: "lexical-graph-neighborhood-ranker-v1",
    generatedAt: now,
    answerReady: true,
    nodeBudget: 24,
    relationBudget: 48,
    citationBudget: 12,
    candidateNodeCount: 1,
    candidateRelationCount: 0,
    candidateCitationCount: 1,
    message: "근거가 있는 그래프 검색 결과입니다.",
  },
});

const resultFor = (input, citationId = "block-memory-1", answer = "에이전트 기억은 검증된 결과를 재사용합니다.") => ({
  jobId: input.jobId,
  idempotencyKey: input.idempotencyKey,
  provider: input.provider,
  providerVersion: input.providerVersion,
  promptVersion: input.promptVersion,
  status: "completed",
  answer,
  claims: [{ text: "에이전트 기억은 검증된 결과를 재사용합니다.", citationIds: [citationId] }],
  citationIds: [citationId],
  uncertainty: "low",
  limitations: [],
});

test("그래프 답변 계약은 동일 context를 멱등화하고 존재하지 않는 인용·근거 밖 답변을 거부한다", async () => {
  const { contracts, validator } = await graphAnswerModules();
  const first = await contracts.buildGraphAnswerJobInput({
    retrieval: retrieval(),
    providerVersion: contracts.GRAPH_ANSWER_PROVIDER_VERSION,
  });
  const duplicate = await contracts.buildGraphAnswerJobInput({
    retrieval: retrieval("2026-08-07T00:10:00.000Z"),
    providerVersion: contracts.GRAPH_ANSWER_PROVIDER_VERSION,
  });
  assert.equal(first.idempotencyKey, duplicate.idempotencyKey);
  const job = {
    id: first.jobId,
    idempotencyKey: first.idempotencyKey,
    status: "running",
    input: first,
    attemptCount: 1,
    maxAttempts: 3,
    manualRetryCount: 0,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
  const valid = validator.validateGraphAnswerResult(resultFor(first), job);
  assert.deepEqual(valid.citationIds, ["block-memory-1"]);
  assert.throws(
    () => validator.validateGraphAnswerResult(resultFor(first, "invented-block"), job),
    /context에 없는 인용/,
  );
  assert.throws(
    () => validator.validateGraphAnswerResult(resultFor(first, "block-memory-1", "근거 주장 외 추가 단정"), job),
    /claims의 텍스트만/,
  );
});

async function exerciseRepository(candidate, contracts) {
  const input = await contracts.buildGraphAnswerJobInput({
    retrieval: retrieval(),
    providerVersion: contracts.GRAPH_ANSWER_PROVIDER_VERSION,
  });
  assert.equal((await candidate.enqueue(input, { now: "2026-08-07T01:00:00.000Z" })).created, true);
  assert.equal((await candidate.enqueue(input, { now: "2026-08-07T01:00:01.000Z" })).created, false);
  const leased = await candidate.claim({
    runtimeId: "runtime-answer",
    leaseDurationMs: 1_000,
    now: "2026-08-07T01:00:02.000Z",
  });
  assert.equal(leased.status, "leased");
  await assert.rejects(
    candidate.renewLease({ jobId: input.jobId, runtimeId: "other", now: "2026-08-07T01:00:02.100Z" }),
    (error) => error.code === "lease_conflict",
  );
  assert.equal((await candidate.markRunning({
    jobId: input.jobId,
    runtimeId: "runtime-answer",
    now: "2026-08-07T01:00:02.200Z",
  })).status, "running");
  assert.equal((await candidate.complete({
    jobId: input.jobId,
    runtimeId: "runtime-answer",
    result: resultFor(input),
    now: "2026-08-07T01:00:02.300Z",
  })).status, "completed");

  const retryInput = await contracts.buildGraphAnswerJobInput({
    retrieval: { ...retrieval(), query: { original: "다른 기억", normalized: "다른 기억", terms: ["다른", "기억"] } },
    providerVersion: contracts.GRAPH_ANSWER_PROVIDER_VERSION,
  });
  await candidate.enqueue(retryInput, { now: "2026-08-07T01:00:03.000Z", maxAttempts: 1 });
  await candidate.claim({ runtimeId: "runtime-answer", now: "2026-08-07T01:00:03.100Z" });
  assert.equal((await candidate.fail({
    jobId: retryInput.jobId,
    runtimeId: "runtime-answer",
    errorCode: "provider_timeout",
    errorMessage: "timeout",
    retryable: true,
    now: "2026-08-07T01:00:03.200Z",
  })).status, "failed");
  assert.equal((await candidate.retry(retryInput.jobId, "2026-08-07T01:00:03.300Z")).status, "queued");
  assert.equal((await candidate.cancel(retryInput.jobId, "2026-08-07T01:00:03.400Z")).status, "cancelled");
  return candidate.statusCounts();
}

test("그래프 답변 Memory·D1 저장소는 Lease·완료·실패·재시도·취소 상태를 동일하게 보존한다", async () => {
  const { contracts, repository } = await graphAnswerModules();
  const sqlite = new SqliteD1Database();
  try {
    const memoryCounts = await exerciseRepository(repository.createMemoryGraphAnswerJobRepository(), contracts);
    const d1Counts = await exerciseRepository(repository.createD1GraphAnswerJobRepository(sqlite), contracts);
    assert.deepEqual(d1Counts, memoryCounts);
    assert.equal(memoryCounts.completed, 1);
    assert.equal(memoryCounts.cancelled, 1);
  } finally {
    sqlite.close();
  }
});

test.after(async () => {
  if (modulesPromise) await (await modulesPromise).cleanup();
});
