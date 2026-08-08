import assert from "node:assert/strict";
import test from "node:test";
import { IntegratedRuntimeRunner } from "../.runtime-dist/server/runtime/runner.js";
import { parseRuntimeRunOptions } from "../.runtime-dist/server/runtime/run-policy.js";

const config = {
  baseUrl: "http://localhost:3000",
  runtimeId: "runtime-runner-test",
  pollIntervalMs: 1,
  statusIntervalMs: 10_000,
  leaseDurationMs: 90_000,
  codexTimeoutMs: 180_000,
  githubTimeoutMs: 120_000,
  maxInputBytes: 256_000,
  maximumBackoffMs: 10,
  model: undefined,
  codexPath: undefined,
  ghPath: undefined,
  deleteSessionAfterRun: true,
  version: "atlas-runtime-test",
};

const job = (id) => ({
  id,
  idempotencyKey: `key-${id}`,
  documentId: `document-${id}`,
  documentHash: `hash-${id}`,
  parserVersion: "parser-v1",
  provider: "codex",
  providerVersion: "codex-sdk-test",
  promptVersion: "prompt-v1",
  status: "leased",
  input: {
    jobId: id,
    idempotencyKey: `key-${id}`,
    document: { id: `document-${id}`, name: `${id}.md`, hash: `hash-${id}`, parserVersion: "parser-v1" },
    provider: "codex",
    providerVersion: "codex-sdk-test",
    promptVersion: "prompt-v1",
    nodes: [],
    existingRelations: [],
    evidenceBlocks: [],
    constraints: { allowedRelationTypes: ["supports"], maxCandidateRelations: 10, evidenceRequired: true },
  },
  attemptCount: 1,
  maxAttempts: 3,
  manualRetryCount: 0,
  leaseOwner: "runtime-runner-test",
  leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const resultFor = (candidate) => ({
  jobId: candidate.id,
  idempotencyKey: candidate.idempotencyKey,
  documentHash: candidate.documentHash,
  provider: "codex",
  providerVersion: candidate.providerVersion,
  promptVersion: candidate.promptVersion,
  status: "completed",
  relations: [],
  warnings: [],
});

const graphAnswerJob = () => ({
  id: "graph-answer:runner-test",
  idempotencyKey: "graph-answer-runner-key",
  status: "leased",
  input: {
    jobId: "graph-answer:runner-test",
    idempotencyKey: "graph-answer-runner-key",
    provider: "codex",
    providerVersion: "codex-sdk-test",
    promptVersion: "atlas-graph-answer-v1",
    question: "에이전트 기억은 무엇인가요?",
    retrieval: {
      algorithm: "lexical-graph-neighborhood-ranker-v1",
      contextFingerprint: "fingerprint",
      nodes: [],
      relations: [],
      citations: [{ id: "citation-1", text: "검증된 결과를 기억합니다.", nodeIds: [] }],
    },
    constraints: { allowedCitationIds: ["citation-1"], evidenceRequired: true, maxClaims: 12 },
  },
  attemptCount: 1,
  maxAttempts: 3,
  manualRetryCount: 0,
  leaseOwner: "runtime-runner-test",
  leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

test("Runtime runner processes jobs sequentially with concurrency one", async () => {
  const queue = [job("job-1"), job("job-2")];
  const events = [];
  let runner;
  const client = {
    async claim() {
      const next = queue.shift() ?? null;
      if (!next) runner.stop();
      return next;
    },
    async start(id) { events.push(`start:${id}`); return job(id); },
    async renewLease(id) { events.push(`renew:${id}`); return job(id); },
    async submit(id) { events.push(`submit:${id}`); return { ...job(id), status: "completed" }; },
    async fail(id) { events.push(`fail:${id}`); return { ...job(id), status: "failed" }; },
    async reportRuntimeStatus(status) { events.push(`heartbeat:${status}`); return { lastSeenAt: new Date().toISOString() }; },
  };
  const engine = {
    async checkAuthentication() { events.push("auth"); },
    async enrich(candidate) {
      events.push(`enrich:${candidate.id}`);
      return resultFor(candidate);
    },
  };
  runner = new IntegratedRuntimeRunner(config, { client, engine });
  await runner.run();
  assert.deepEqual(events, [
    "heartbeat:online",
    "auth",
    "start:job-1",
    "enrich:job-1",
    "submit:job-1",
    "start:job-2",
    "enrich:job-2",
    "submit:job-2",
    "heartbeat:offline",
  ]);
});

test("통합 런타임 shutdown aborts active work and reports a retryable failure", async () => {
  const candidate = job("job-abort");
  const failures = [];
  const client = {
    async claim() { return candidate; },
    async start() { return candidate; },
    async renewLease() { return candidate; },
    async submit() { throw new Error("submit must not run"); },
    async fail(id, failure) {
      failures.push({ id, failure });
      return { ...candidate, status: "queued" };
    },
    async reportRuntimeStatus() { return { lastSeenAt: new Date().toISOString() }; },
  };
  const engine = {
    async checkAuthentication() {},
    async enrich(_job, signal) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("aborted");
    },
  };
  const runner = new IntegratedRuntimeRunner(config, { client, engine });
  const running = runner.run({ once: true });
  setTimeout(() => runner.stop(), 5);
  await running;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, candidate.id);
  assert.equal(failures[0].failure.retryable, true);
});

test("Runtime runner는 그래프 답변을 일반 관계 보강보다 먼저 구조화 처리한다", async () => {
  const candidate = graphAnswerJob();
  const events = [];
  let claimed = false;
  const client = {
    async claim() { events.push("claim-enrichment"); return null; },
    async start() {},
    async renewLease() {},
    async submit() {},
    async fail() {},
    async reportRuntimeStatus(status) { events.push(`heartbeat:${status}`); return { lastSeenAt: new Date().toISOString() }; },
    async claimGraphAnswer() {
      events.push("claim-answer");
      if (claimed) return null;
      claimed = true;
      return candidate;
    },
    async startGraphAnswer() { events.push("start-answer"); return { ...candidate, status: "running" }; },
    async renewGraphAnswerLease() { return candidate; },
    async submitGraphAnswer() { events.push("submit-answer"); return { ...candidate, status: "completed" }; },
    async failGraphAnswer() { events.push("fail-answer"); return { ...candidate, status: "failed" }; },
  };
  const engine = {
    async checkAuthentication() { events.push("auth"); },
    async enrich() { throw new Error("enrichment must not run"); },
    async answerGraphQuery() {
      events.push("answer");
      return {
        jobId: candidate.id,
        idempotencyKey: candidate.idempotencyKey,
        provider: "codex",
        providerVersion: "codex-sdk-test",
        promptVersion: "atlas-graph-answer-v1",
        status: "completed",
        answer: "검증된 결과를 기억합니다.",
        claims: [{ text: "검증된 결과를 기억합니다.", citationIds: ["citation-1"] }],
        citationIds: ["citation-1"],
        uncertainty: "low",
        limitations: [],
      };
    },
  };
  const runner = new IntegratedRuntimeRunner(config, { client, engine });
  await runner.run({ once: true });
  assert.deepEqual(events, [
    "heartbeat:online",
    "claim-answer",
    "auth",
    "start-answer",
    "answer",
    "submit-answer",
    "heartbeat:offline",
  ]);
});

test("그래프 답변 timeout은 활성 SDK 호출을 중단하고 작업을 재시도 가능하게 보고한다", async () => {
  const candidate = graphAnswerJob();
  const failures = [];
  let claimed = false;
  const client = {
    async claim() { return null; },
    async start() {},
    async renewLease() {},
    async submit() {},
    async fail() {},
    async reportRuntimeStatus() { return { lastSeenAt: new Date().toISOString(), queuedJobs: failures.length ? 1 : 0 }; },
    async claimGraphAnswer() {
      if (claimed) return null;
      claimed = true;
      return candidate;
    },
    async startGraphAnswer() { return { ...candidate, status: "running" }; },
    async renewGraphAnswerLease() { return candidate; },
    async submitGraphAnswer() { throw new Error("submit must not run"); },
    async failGraphAnswer(id, failure) {
      failures.push({ id, failure });
      return { ...candidate, status: "queued" };
    },
  };
  const engine = {
    async checkAuthentication() {},
    async enrich() { throw new Error("enrichment must not run"); },
    async answerGraphQuery(_job, signal) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("graph answer timeout");
    },
  };
  const runner = new IntegratedRuntimeRunner(config, { client, engine });
  const receipt = await runner.run({ maxJobs: 1, maxRuntimeMs: 20, stopWhenIdle: true });
  assert.equal(receipt.stopReason, "runtime_limit");
  assert.equal(receipt.failedJobs, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, candidate.id);
  assert.equal(failures[0].failure.retryable, true);
});

test("Runtime runner는 GitHub discovery를 일반 보강보다 먼저 단일 처리한다", async () => {
  const events = [];
  const source = {
    id: "github-source:discovery:runner-test",
    idempotencyKey: "runner-test-key",
    kind: "discovery",
    owner: "coreline-ai",
    status: "leased",
    input: {
      jobId: "github-source:discovery:runner-test",
      idempotencyKey: "runner-test-key",
      kind: "discovery",
      owner: "coreline-ai",
      selectedRepositoryIds: [],
    },
    attemptCount: 1,
    maxAttempts: 3,
    manualRetryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const capability = {
    capability: "github-source",
    status: "online",
    accountLogin: "coreline-ai",
    host: "github.com",
    checkedAt: new Date().toISOString(),
  };
  const result = {
    jobId: source.id,
    idempotencyKey: source.idempotencyKey,
    kind: "discovery",
    status: "completed",
    capability,
    summary: {
      discoveredCount: 117,
      selectedCount: 100,
      changedCount: 0,
      unchangedCount: 0,
      deletedCount: 0,
      failedCount: 0,
    },
  };
  let claimed = false;
  const client = {
    async claim() { events.push("claim-enrichment"); return null; },
    async start() {},
    async renewLease() {},
    async submit() {},
    async fail() {},
    async reportRuntimeStatus(status) { events.push(`heartbeat:${status}`); return { lastSeenAt: new Date().toISOString() }; },
    async reportGitHubRuntimeStatus() { events.push("github-capability"); return capability; },
    async claimGitHubSource() {
      events.push("claim-github");
      if (claimed) return null;
      claimed = true;
      return source;
    },
    async startGitHubSource() { events.push("start-github"); return { ...source, status: "running" }; },
    async renewGitHubSourceLease() { return source; },
    async submitGitHubSource() { events.push("submit-github"); return { ...source, status: "completed" }; },
    async failGitHubSource() { events.push("fail-github"); return { ...source, status: "failed" }; },
  };
  const engine = {
    async checkAuthentication() { events.push("auth"); },
    async enrich() { throw new Error("enrichment must not run"); },
  };
  const sourceEngine = {
    async checkCapability() { events.push("check-github"); return capability; },
    async executeJob() { events.push("execute-github"); return result; },
  };
  const runner = new IntegratedRuntimeRunner(config, { client, engine, sourceEngine });
  await runner.run({ once: true });
  assert.deepEqual(events, [
    "heartbeat:online",
    "check-github",
    "github-capability",
    "claim-github",
    "start-github",
    "execute-github",
    "github-capability",
    "submit-github",
    "heartbeat:offline",
  ]);
});

test("제한 실행 CLI는 기본 연속 모드와 0·1개 안전 상한을 구분한다", () => {
  assert.deepEqual(parseRuntimeRunOptions([], {}), {
    once: false,
    maxJobs: undefined,
    maxRuntimeMs: undefined,
    enrichmentOnly: false,
    stopWhenIdle: false,
  });
  assert.deepEqual(parseRuntimeRunOptions([
    "--max-jobs=0",
    "--max-runtime-ms",
    "1000",
    "--enrichment-only",
  ], {}), {
    once: false,
    maxJobs: 0,
    maxRuntimeMs: 1_000,
    enrichmentOnly: true,
    stopWhenIdle: true,
  });
  assert.equal(parseRuntimeRunOptions(["--once"], {}).maxJobs, 1);
  const batch = parseRuntimeRunOptions(["--batch", "--max-jobs=5"], {});
  assert.equal(batch.maxJobs, 5);
  assert.equal(batch.maxRuntimeMs, 300_000);
  assert.equal(batch.stopWhenIdle, true);
  assert.throws(
    () => parseRuntimeRunOptions(["--max-jobs=101"], {}),
    /0~100/,
  );
});

test("max jobs 0은 작업을 claim하지 않는 dry-run 영수증을 반환한다", async () => {
  const events = [];
  const client = {
    async claim() { events.push("claim"); return job("must-not-claim"); },
    async start() {},
    async renewLease() {},
    async submit() {},
    async fail() {},
    async reportRuntimeStatus(status) {
      events.push(`heartbeat:${status}`);
      return { lastSeenAt: new Date().toISOString(), queuedJobs: 3, activeJobs: 0 };
    },
  };
  const engine = {
    async checkAuthentication() { events.push("auth"); },
    async enrich() { throw new Error("must not run"); },
  };
  const runner = new IntegratedRuntimeRunner(config, { client, engine });
  const receipt = await runner.run({ maxJobs: 0, enrichmentOnly: true, stopWhenIdle: true });
  assert.deepEqual(events, ["heartbeat:online", "heartbeat:offline"]);
  assert.equal(receipt.stopReason, "dry_run");
  assert.equal(receipt.claimedJobs, 0);
  assert.equal(receipt.initialQueuedJobs, 3);
  assert.equal(receipt.remainingQueuedJobs, 3);
});

test("max jobs N은 정확한 수량만 순차 처리하고 잔여 대기열 영수증을 남긴다", async () => {
  const queue = [job("bounded-1"), job("bounded-2"), job("bounded-3")];
  const events = [];
  const client = {
    async claim() { return queue.shift() ?? null; },
    async start(id) { events.push(`start:${id}`); return job(id); },
    async renewLease(id) { return job(id); },
    async submit(id) {
      events.push(`submit:${id}`);
      return { ...job(id), status: id === "bounded-2" ? "warning" : "completed" };
    },
    async fail() { throw new Error("fail must not run"); },
    async reportRuntimeStatus() {
      return { lastSeenAt: new Date().toISOString(), queuedJobs: queue.length, activeJobs: 0 };
    },
  };
  const engine = {
    async checkAuthentication() {},
    async enrich(candidate) { return resultFor(candidate); },
  };
  const runner = new IntegratedRuntimeRunner(config, { client, engine });
  const receipt = await runner.run({ maxJobs: 2, enrichmentOnly: true, stopWhenIdle: true });
  assert.deepEqual(events, [
    "start:bounded-1",
    "submit:bounded-1",
    "start:bounded-2",
    "submit:bounded-2",
  ]);
  assert.equal(receipt.stopReason, "job_limit");
  assert.equal(receipt.claimedJobs, 2);
  assert.equal(receipt.succeededJobs, 1);
  assert.equal(receipt.warningJobs, 1);
  assert.equal(receipt.failedJobs, 0);
  assert.equal(receipt.initialQueuedJobs, 3);
  assert.equal(receipt.remainingQueuedJobs, 1);
  assert.equal(queue[0].id, "bounded-3");
});

test("max runtime 도달은 활성 작업을 중단하고 재시도 가능한 실패 영수증으로 종료한다", async () => {
  const candidate = job("bounded-timeout");
  const failures = [];
  let claimed = false;
  const client = {
    async claim() {
      if (claimed) return null;
      claimed = true;
      return candidate;
    },
    async start() { return candidate; },
    async renewLease() { return candidate; },
    async submit() { throw new Error("submit must not run"); },
    async fail(id, failure) {
      failures.push({ id, failure });
      return { ...candidate, status: "queued" };
    },
    async reportRuntimeStatus() {
      return { lastSeenAt: new Date().toISOString(), queuedJobs: failures.length ? 1 : 0, activeJobs: 0 };
    },
  };
  const engine = {
    async checkAuthentication() {},
    async enrich(_candidate, signal) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("runtime limit");
    },
  };
  const runner = new IntegratedRuntimeRunner(config, { client, engine });
  const receipt = await runner.run({
    maxJobs: 1,
    maxRuntimeMs: 20,
    enrichmentOnly: true,
    stopWhenIdle: true,
  });
  assert.equal(receipt.stopReason, "runtime_limit");
  assert.equal(receipt.claimedJobs, 1);
  assert.equal(receipt.failedJobs, 1);
  assert.equal(receipt.remainingQueuedJobs, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].failure.retryable, true);
});
