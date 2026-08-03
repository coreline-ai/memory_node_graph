import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorRunner } from "../.connector-dist/connector/runner.js";

const config = {
  baseUrl: "http://localhost:3000",
  token: "",
  connectorId: "connector-runner-test",
  pollIntervalMs: 1,
  heartbeatIntervalMs: 10_000,
  leaseDurationMs: 90_000,
  codexTimeoutMs: 180_000,
  maxInputBytes: 256_000,
  maximumBackoffMs: 10,
  model: undefined,
  codexPath: undefined,
  deleteSessionAfterRun: true,
  version: "atlas-connector-test",
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
  leaseOwner: "connector-runner-test",
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

test("Connector runner processes jobs sequentially with concurrency one", async () => {
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
    async heartbeat(status) { events.push(`heartbeat:${status}`); return { lastSeenAt: new Date().toISOString() }; },
  };
  const engine = {
    async checkAuthentication() { events.push("auth"); },
    async enrich(candidate) {
      events.push(`enrich:${candidate.id}`);
      return resultFor(candidate);
    },
  };
  runner = new ConnectorRunner(config, { client, engine });
  await runner.run();
  assert.deepEqual(events, [
    "auth",
    "heartbeat:online",
    "start:job-1",
    "enrich:job-1",
    "submit:job-1",
    "start:job-2",
    "enrich:job-2",
    "submit:job-2",
    "heartbeat:offline",
  ]);
});

test("Connector shutdown aborts active work and reports a retryable failure", async () => {
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
    async heartbeat() { return { lastSeenAt: new Date().toISOString() }; },
  };
  const engine = {
    async checkAuthentication() {},
    async enrich(_job, signal) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("aborted");
    },
  };
  const runner = new ConnectorRunner(config, { client, engine });
  const running = runner.run({ once: true });
  setTimeout(() => runner.stop(), 5);
  await running;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].id, candidate.id);
  assert.equal(failures[0].failure.retryable, true);
});
