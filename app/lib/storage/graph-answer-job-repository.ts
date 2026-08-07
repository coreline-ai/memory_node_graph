import {
  type GraphAnswerErrorCode,
  type GraphAnswerJobInput,
  type GraphAnswerJobRecord,
  type GraphAnswerJobStatus,
  type GraphAnswerResult,
} from "../llm/graph-answer-contracts";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 60_000;
export const MAX_MANUAL_GRAPH_ANSWER_RETRIES = 2;

type EnqueueOptions = { now?: string; maxAttempts?: number };
type ClaimOptions = { connectorId: string; leaseDurationMs?: number; now?: string };
type LeaseMutation = { jobId: string; connectorId: string; now?: string };
type RenewLeaseInput = LeaseMutation & { leaseDurationMs?: number };
type CompleteInput = LeaseMutation & { result: GraphAnswerResult };
type FailInput = LeaseMutation & {
  errorCode: GraphAnswerErrorCode;
  errorMessage: string;
  retryable: boolean;
};

export type GraphAnswerJobStatusCounts = Record<GraphAnswerJobStatus, number>;

const emptyStatusCounts = (): GraphAnswerJobStatusCounts => ({
  queued: 0,
  leased: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
});

export interface GraphAnswerJobRepository {
  enqueue(input: GraphAnswerJobInput, options?: EnqueueOptions): Promise<{
    job: GraphAnswerJobRecord;
    created: boolean;
  }>;
  get(jobId: string): Promise<GraphAnswerJobRecord | null>;
  statusCounts(): Promise<GraphAnswerJobStatusCounts>;
  claim(options: ClaimOptions): Promise<GraphAnswerJobRecord | null>;
  renewLease(input: RenewLeaseInput): Promise<GraphAnswerJobRecord>;
  markRunning(input: LeaseMutation): Promise<GraphAnswerJobRecord>;
  complete(input: CompleteInput): Promise<GraphAnswerJobRecord>;
  fail(input: FailInput): Promise<GraphAnswerJobRecord>;
  cancel(jobId: string, now?: string): Promise<GraphAnswerJobRecord>;
  retry(jobId: string, now?: string): Promise<GraphAnswerJobRecord>;
}

export class GraphAnswerRepositoryError extends Error {
  constructor(readonly code: GraphAnswerErrorCode, message: string) {
    super(message);
    this.name = "GraphAnswerRepositoryError";
  }
}

const timestamp = (value?: string) => value ?? new Date().toISOString();
const expiresAt = (now: string, duration = DEFAULT_LEASE_MS) =>
  new Date(Date.parse(now) + Math.max(1_000, duration)).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const isLeaseStatus = (status: GraphAnswerJobStatus) => status === "leased" || status === "running";
const isExpired = (job: GraphAnswerJobRecord, now: string) =>
  !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(now);

const transitions: Readonly<Record<GraphAnswerJobStatus, readonly GraphAnswerJobStatus[]>> = {
  queued: ["leased", "cancelled"],
  leased: ["leased", "running", "queued", "completed", "failed", "cancelled"],
  running: ["leased", "queued", "completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
};

const assertTransition = (from: GraphAnswerJobStatus, to: GraphAnswerJobStatus) => {
  if (!transitions[from].includes(to)) {
    throw new GraphAnswerRepositoryError(
      "invalid_input",
      `허용되지 않은 그래프 답변 작업 상태 전이입니다: ${from} -> ${to}`,
    );
  }
};

const requireJob = (job: GraphAnswerJobRecord | null) => {
  if (!job) throw new GraphAnswerRepositoryError("invalid_input", "그래프 답변 작업을 찾을 수 없습니다.");
  return job;
};

const assertLease = (job: GraphAnswerJobRecord, connectorId: string, now: string) => {
  if (!isLeaseStatus(job.status) || job.leaseOwner !== connectorId) {
    throw new GraphAnswerRepositoryError("lease_conflict", "현재 Connector가 소유한 답변 작업 Lease가 아닙니다.");
  }
  if (isExpired(job, now)) {
    throw new GraphAnswerRepositoryError("lease_expired", "그래프 답변 작업 Lease가 만료되었습니다.");
  }
};

const newJob = (input: GraphAnswerJobInput, options: EnqueueOptions = {}): GraphAnswerJobRecord => {
  const now = timestamp(options.now);
  return {
    id: input.jobId,
    idempotencyKey: input.idempotencyKey,
    status: "queued",
    input: clone(input),
    attemptCount: 0,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    manualRetryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
};

export class MemoryGraphAnswerJobRepository implements GraphAnswerJobRepository {
  constructor(private readonly jobs = new Map<string, GraphAnswerJobRecord>()) {}

  async enqueue(input: GraphAnswerJobInput, options: EnqueueOptions = {}) {
    const existing = [...this.jobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) return { job: clone(existing), created: false };
    const job = newJob(input, options);
    this.jobs.set(job.id, job);
    return { job: clone(job), created: true };
  }

  async get(jobId: string) {
    const job = this.jobs.get(jobId);
    return job ? clone(job) : null;
  }

  async statusCounts() {
    const counts = emptyStatusCounts();
    for (const job of this.jobs.values()) counts[job.status] += 1;
    return counts;
  }

  async claim(options: ClaimOptions) {
    const now = timestamp(options.now);
    for (const job of [...this.jobs.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      const claimable = job.status === "queued" || (isLeaseStatus(job.status) && isExpired(job, now));
      if (!claimable) continue;
      if (job.attemptCount >= job.maxAttempts) {
        if (isLeaseStatus(job.status)) {
          job.status = "failed";
          job.errorCode = "retry_exhausted";
          job.errorMessage = "최대 답변 생성 재시도 횟수를 초과했습니다.";
          job.leaseOwner = undefined;
          job.leaseExpiresAt = undefined;
          job.updatedAt = now;
          job.completedAt = now;
        }
        continue;
      }
      assertTransition(job.status, "leased");
      job.status = "leased";
      job.attemptCount += 1;
      job.leaseOwner = options.connectorId;
      job.leaseExpiresAt = expiresAt(now, options.leaseDurationMs);
      job.errorCode = undefined;
      job.errorMessage = undefined;
      job.updatedAt = now;
      return clone(job);
    }
    return null;
  }

  async renewLease(input: RenewLeaseInput) {
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.connectorId, now);
    const stored = requireJob(this.jobs.get(job.id) ?? null);
    stored.leaseExpiresAt = expiresAt(now, input.leaseDurationMs);
    stored.updatedAt = now;
    return clone(stored);
  }

  async markRunning(input: LeaseMutation) {
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.connectorId, now);
    if (job.status !== "leased") {
      throw new GraphAnswerRepositoryError("invalid_input", "leased 답변 작업만 running으로 전환할 수 있습니다.");
    }
    assertTransition(job.status, "running");
    const stored = requireJob(this.jobs.get(job.id) ?? null);
    stored.status = "running";
    stored.startedAt ??= now;
    stored.updatedAt = now;
    return clone(stored);
  }

  async complete(input: CompleteInput) {
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.connectorId, now);
    assertTransition(job.status, "completed");
    const stored = requireJob(this.jobs.get(job.id) ?? null);
    stored.status = "completed";
    stored.result = clone(input.result);
    stored.errorCode = undefined;
    stored.errorMessage = undefined;
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = now;
    return clone(stored);
  }

  async fail(input: FailInput) {
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.connectorId, now);
    const nextStatus: GraphAnswerJobStatus = input.retryable && job.attemptCount < job.maxAttempts
      ? "queued"
      : "failed";
    assertTransition(job.status, nextStatus);
    const stored = requireJob(this.jobs.get(job.id) ?? null);
    stored.status = nextStatus;
    stored.errorCode = input.errorCode;
    stored.errorMessage = input.errorMessage.slice(0, 1_000);
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = nextStatus === "failed" ? now : undefined;
    return clone(stored);
  }

  async cancel(jobId: string, nowValue?: string) {
    const now = timestamp(nowValue);
    const stored = requireJob(this.jobs.get(jobId) ?? null);
    if (stored.status === "cancelled") return clone(stored);
    assertTransition(stored.status, "cancelled");
    stored.status = "cancelled";
    stored.errorCode = "cancelled";
    stored.errorMessage = "사용자가 그래프 답변 작업을 취소했습니다.";
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = now;
    return clone(stored);
  }

  async retry(jobId: string, nowValue?: string) {
    const now = timestamp(nowValue);
    const stored = requireJob(this.jobs.get(jobId) ?? null);
    if (stored.status !== "failed") {
      throw new GraphAnswerRepositoryError("invalid_input", "실패한 그래프 답변 작업만 다시 시도할 수 있습니다.");
    }
    if (stored.manualRetryCount >= MAX_MANUAL_GRAPH_ANSWER_RETRIES) {
      throw new GraphAnswerRepositoryError("retry_exhausted", "그래프 답변 수동 재시도 한도를 초과했습니다.");
    }
    assertTransition(stored.status, "queued");
    stored.status = "queued";
    stored.result = undefined;
    stored.attemptCount = 0;
    stored.manualRetryCount += 1;
    stored.lastManualRetryAt = now;
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.errorCode = undefined;
    stored.errorMessage = undefined;
    stored.startedAt = undefined;
    stored.completedAt = undefined;
    stored.updatedAt = now;
    return clone(stored);
  }
}

type D1Row = Record<string, unknown>;

const parseJson = <T>(value: unknown): T | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const asD1Job = (row: D1Row): GraphAnswerJobRecord => ({
  id: String(row.id),
  idempotencyKey: String(row.idempotency_key),
  status: String(row.status) as GraphAnswerJobStatus,
  input: parseJson<GraphAnswerJobInput>(row.input_json)!,
  result: parseJson<GraphAnswerResult>(row.result_json),
  attemptCount: Number(row.attempt_count),
  maxAttempts: Number(row.max_attempts),
  manualRetryCount: Number(row.manual_retry_count ?? 0),
  lastManualRetryAt: row.last_manual_retry_at ? String(row.last_manual_retry_at) : undefined,
  leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
  leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
  errorCode: row.error_code ? String(row.error_code) as GraphAnswerErrorCode : undefined,
  errorMessage: row.error_message ? String(row.error_message) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  startedAt: row.started_at ? String(row.started_at) : undefined,
  completedAt: row.completed_at ? String(row.completed_at) : undefined,
});

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS graph_answer_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    input_json TEXT NOT NULL,
    result_json TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    manual_retry_count INTEGER NOT NULL DEFAULT 0,
    last_manual_retry_at TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS graph_answer_jobs_claim_idx
    ON graph_answer_jobs(status, lease_expires_at, created_at)`,
] as const;

export class D1GraphAnswerJobRepository implements GraphAnswerJobRepository {
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly db: D1Database) {}

  private async ready() {
    this.readyPromise ??= this.db.batch(schemaStatements.map((sql) => this.db.prepare(sql))).then(() => undefined);
    await this.readyPromise;
  }

  async enqueue(input: GraphAnswerJobInput, options: EnqueueOptions = {}) {
    await this.ready();
    const job = newJob(input, options);
    const outcome = await this.db.prepare(`INSERT OR IGNORE INTO graph_answer_jobs
      (id, idempotency_key, status, input_json, result_json, attempt_count, max_attempts,
       manual_retry_count, last_manual_retry_at, lease_owner, lease_expires_at, error_code,
       error_message, created_at, updated_at, started_at, completed_at)
      VALUES (?, ?, 'queued', ?, NULL, 0, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`)
      .bind(job.id, job.idempotencyKey, JSON.stringify(job.input), job.maxAttempts, job.createdAt, job.updatedAt)
      .run();
    const row = await this.db.prepare("SELECT * FROM graph_answer_jobs WHERE idempotency_key = ? LIMIT 1")
      .bind(job.idempotencyKey).first<D1Row>();
    return { job: requireJob(row ? asD1Job(row) : null), created: Number(outcome.meta.changes ?? 0) === 1 };
  }

  async get(jobId: string) {
    await this.ready();
    const row = await this.db.prepare("SELECT * FROM graph_answer_jobs WHERE id = ? LIMIT 1")
      .bind(jobId).first<D1Row>();
    return row ? asD1Job(row) : null;
  }

  async statusCounts() {
    await this.ready();
    const counts = emptyStatusCounts();
    const rows = await this.db.prepare("SELECT status, COUNT(*) AS count FROM graph_answer_jobs GROUP BY status")
      .all<{ status: string; count: number }>();
    for (const row of rows.results) {
      if (row.status in counts) counts[row.status as GraphAnswerJobStatus] = Number(row.count);
    }
    return counts;
  }

  async claim(options: ClaimOptions) {
    await this.ready();
    const now = timestamp(options.now);
    await this.db.prepare(`UPDATE graph_answer_jobs SET status = 'failed', error_code = 'retry_exhausted',
      error_message = '최대 답변 생성 재시도 횟수를 초과했습니다.', lease_owner = NULL,
      lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE status IN ('leased', 'running') AND lease_expires_at <= ? AND attempt_count >= max_attempts`)
      .bind(now, now, now).run();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.db.prepare(`SELECT * FROM graph_answer_jobs
        WHERE attempt_count < max_attempts
          AND (status = 'queued' OR (status IN ('leased', 'running') AND lease_expires_at <= ?))
        ORDER BY created_at LIMIT 1`).bind(now).first<D1Row>();
      if (!row) return null;
      const job = asD1Job(row);
      const outcome = await this.db.prepare(`UPDATE graph_answer_jobs
        SET status = 'leased', attempt_count = attempt_count + 1, lease_owner = ?,
            lease_expires_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND attempt_count = ?
          AND (status = 'queued' OR (status IN ('leased', 'running') AND lease_expires_at <= ?))`)
        .bind(
          options.connectorId,
          expiresAt(now, options.leaseDurationMs),
          now,
          job.id,
          job.attemptCount,
          now,
        ).run();
      if (Number(outcome.meta.changes ?? 0) === 1) return requireJob(await this.get(job.id));
    }
    return null;
  }

  private async classifyLeaseFailure(jobId: string, connectorId: string, now: string): Promise<never> {
    const job = requireJob(await this.get(jobId));
    assertLease(job, connectorId, now);
    throw new GraphAnswerRepositoryError("lease_conflict", "동시 상태 변경으로 답변 작업 Lease 갱신에 실패했습니다.");
  }

  async renewLease(input: RenewLeaseInput) {
    await this.ready();
    const now = timestamp(input.now);
    const outcome = await this.db.prepare(`UPDATE graph_answer_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
      .bind(expiresAt(now, input.leaseDurationMs), now, input.jobId, input.connectorId, now).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.connectorId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async markRunning(input: LeaseMutation) {
    await this.ready();
    const now = timestamp(input.now);
    const outcome = await this.db.prepare(`UPDATE graph_answer_jobs
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status = 'leased' AND lease_expires_at > ?`)
      .bind(now, now, input.jobId, input.connectorId, now).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      const job = requireJob(await this.get(input.jobId));
      assertLease(job, input.connectorId, now);
      throw new GraphAnswerRepositoryError("invalid_input", "leased 답변 작업만 running으로 전환할 수 있습니다.");
    }
    return requireJob(await this.get(input.jobId));
  }

  async complete(input: CompleteInput) {
    await this.ready();
    const now = timestamp(input.now);
    const outcome = await this.db.prepare(`UPDATE graph_answer_jobs
      SET status = 'completed', result_json = ?, error_code = NULL, error_message = NULL,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
      .bind(JSON.stringify(input.result), now, now, input.jobId, input.connectorId, now).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.connectorId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async fail(input: FailInput) {
    await this.ready();
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.connectorId, now);
    const nextStatus: GraphAnswerJobStatus = input.retryable && job.attemptCount < job.maxAttempts
      ? "queued"
      : "failed";
    const outcome = await this.db.prepare(`UPDATE graph_answer_jobs
      SET status = ?, error_code = ?, error_message = ?, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
      .bind(
        nextStatus,
        input.errorCode,
        input.errorMessage.slice(0, 1_000),
        now,
        nextStatus === "failed" ? now : null,
        input.jobId,
        input.connectorId,
        now,
      ).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.connectorId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async cancel(jobId: string, nowValue?: string) {
    await this.ready();
    const now = timestamp(nowValue);
    const outcome = await this.db.prepare(`UPDATE graph_answer_jobs
      SET status = 'cancelled', error_code = 'cancelled',
          error_message = '사용자가 그래프 답변 작업을 취소했습니다.', lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND status IN ('queued', 'leased', 'running')`)
      .bind(now, now, jobId).run();
    const job = requireJob(await this.get(jobId));
    if (Number(outcome.meta.changes ?? 0) === 0 && job.status !== "cancelled") {
      assertTransition(job.status, "cancelled");
    }
    return job;
  }

  async retry(jobId: string, nowValue?: string) {
    await this.ready();
    const now = timestamp(nowValue);
    const job = requireJob(await this.get(jobId));
    if (job.status !== "failed") {
      throw new GraphAnswerRepositoryError("invalid_input", "실패한 그래프 답변 작업만 다시 시도할 수 있습니다.");
    }
    if (job.manualRetryCount >= MAX_MANUAL_GRAPH_ANSWER_RETRIES) {
      throw new GraphAnswerRepositoryError("retry_exhausted", "그래프 답변 수동 재시도 한도를 초과했습니다.");
    }
    const outcome = await this.db.prepare(`UPDATE graph_answer_jobs
      SET status = 'queued', result_json = NULL, attempt_count = 0,
          manual_retry_count = manual_retry_count + 1, last_manual_retry_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
          error_message = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed' AND manual_retry_count < ?`)
      .bind(now, now, jobId, MAX_MANUAL_GRAPH_ANSWER_RETRIES).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      throw new GraphAnswerRepositoryError("lease_conflict", "답변 작업 재시도 상태가 동시에 변경되었습니다.");
    }
    return requireJob(await this.get(jobId));
  }
}

const memoryKey = "__AI_ATLAS_GRAPH_ANSWER_JOB_STORE__";
const testDatabaseKey = "__AI_ATLAS_TEST_D1__";

const defaultMemoryRepository = () => {
  const root = globalThis as typeof globalThis & { [memoryKey]?: MemoryGraphAnswerJobRepository };
  root[memoryKey] ??= new MemoryGraphAnswerJobRepository();
  return root[memoryKey];
};

async function database() {
  if (process.env.ATLAS_MEMORY_STORAGE === "true") return null;
  if (process.env.ATLAS_TEST_MODE === "true") {
    const testDatabase = (globalThis as typeof globalThis & { [testDatabaseKey]?: D1Database })[testDatabaseKey];
    if (testDatabase) return testDatabase;
  }
  try {
    const { env } = await import("cloudflare:workers");
    const candidate = env.DB;
    return candidate && typeof candidate.prepare === "function" ? candidate : null;
  } catch {
    return null;
  }
}

export const createMemoryGraphAnswerJobRepository = () => new MemoryGraphAnswerJobRepository();
export const createD1GraphAnswerJobRepository = (db: D1Database) => new D1GraphAnswerJobRepository(db);

export async function getGraphAnswerJobRepository(): Promise<GraphAnswerJobRepository> {
  const db = await database();
  return db ? new D1GraphAnswerJobRepository(db) : defaultMemoryRepository();
}
