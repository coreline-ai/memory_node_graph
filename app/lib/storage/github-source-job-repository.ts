import {
  assertCredentialFreePayload,
  canTransitionGitHubSourceJob,
  MAX_MANUAL_GITHUB_SOURCE_RETRIES,
  validateGitHubSourceJobResult,
  type GitHubConnectorCapabilityRecord,
  type GitHubSourceErrorCode,
  type GitHubSourceJobInput,
  type GitHubSourceJobRecord,
  type GitHubSourceJobResult,
  type GitHubSourceJobStatus,
} from "../github/source-job-contracts";
import type { GitHubApplyStageChunk } from "../github/apply-stage-contracts";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 60_000;

type EnqueueOptions = { now?: string; maxAttempts?: number };
type ClaimOptions = { connectorId: string; leaseDurationMs?: number; now?: string };
type LeaseMutation = { jobId: string; connectorId: string; now?: string };
type RenewLeaseInput = LeaseMutation & { leaseDurationMs?: number };
type CompleteInput = LeaseMutation & { result: unknown };
type FailInput = LeaseMutation & {
  errorCode: GitHubSourceErrorCode;
  errorMessage: string;
  retryable: boolean;
};
type CapabilityInput = Omit<GitHubConnectorCapabilityRecord, "lastSeenAt"> & { now?: string };

export type EnqueueGitHubSourceJobResult = {
  job: GitHubSourceJobRecord;
  created: boolean;
};

export interface GitHubSourceJobRepository {
  enqueue(input: GitHubSourceJobInput, options?: EnqueueOptions): Promise<EnqueueGitHubSourceJobResult>;
  get(jobId: string): Promise<GitHubSourceJobRecord | null>;
  list(): Promise<GitHubSourceJobRecord[]>;
  claim(options: ClaimOptions): Promise<GitHubSourceJobRecord | null>;
  renewLease(input: RenewLeaseInput): Promise<GitHubSourceJobRecord>;
  markRunning(input: LeaseMutation): Promise<GitHubSourceJobRecord>;
  complete(input: CompleteInput): Promise<GitHubSourceJobRecord>;
  fail(input: FailInput): Promise<GitHubSourceJobRecord>;
  cancel(jobId: string, now?: string): Promise<GitHubSourceJobRecord>;
  retry(jobId: string, now?: string): Promise<GitHubSourceJobRecord>;
  recordCapability(input: CapabilityInput): Promise<GitHubConnectorCapabilityRecord>;
  getCapability(connectorId: string): Promise<GitHubConnectorCapabilityRecord | null>;
  listCapabilities(): Promise<GitHubConnectorCapabilityRecord[]>;
  putApplyStageChunk(chunk: GitHubApplyStageChunk): Promise<number>;
  listApplyStageChunks(jobId: string): Promise<GitHubApplyStageChunk[]>;
  deleteApplyStageChunks(jobId: string): Promise<void>;
}

export class GitHubSourceRepositoryError extends Error {
  constructor(readonly code: GitHubSourceErrorCode, message: string) {
    super(message);
    this.name = "GitHubSourceRepositoryError";
  }
}

const timestamp = (value?: string) => value ?? new Date().toISOString();
const expiresAt = (now: string, duration = DEFAULT_LEASE_MS) =>
  new Date(Date.parse(now) + Math.max(1_000, duration)).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const isLeaseStatus = (status: GitHubSourceJobStatus) => status === "leased" || status === "running";
const isActiveStatus = (status: GitHubSourceJobStatus) =>
  status === "queued" || status === "leased" || status === "running";
const applyRepositoryId = (input: GitHubSourceJobInput) =>
  input.kind === "apply" ? input.selectedRepositoryIds[0] : undefined;
const isExpired = (job: GitHubSourceJobRecord, now: string) =>
  !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(now);

function requireJob(job: GitHubSourceJobRecord | null) {
  if (!job) throw new GitHubSourceRepositoryError("invalid_input", "GitHub source 작업을 찾을 수 없습니다.");
  return job;
}

function assertTransition(from: GitHubSourceJobStatus, to: GitHubSourceJobStatus) {
  if (!canTransitionGitHubSourceJob(from, to)) {
    throw new GitHubSourceRepositoryError(
      "invalid_input",
      `허용되지 않은 GitHub source 작업 상태 전이입니다: ${from} -> ${to}`,
    );
  }
}

function assertLease(job: GitHubSourceJobRecord, connectorId: string, now: string) {
  if (!isLeaseStatus(job.status) || job.leaseOwner !== connectorId) {
    throw new GitHubSourceRepositoryError("lease_conflict", "현재 Connector가 소유한 Lease가 아닙니다.");
  }
  if (isExpired(job, now)) {
    throw new GitHubSourceRepositoryError("lease_expired", "GitHub source 작업 Lease가 만료되었습니다.");
  }
}

function failCompletionOnceForTest(jobId: string) {
  if (
    process.env.ATLAS_TEST_MODE === "true"
    && process.env.ATLAS_TEST_FAIL_GITHUB_SOURCE_COMPLETE_ONCE === jobId
  ) {
    delete process.env.ATLAS_TEST_FAIL_GITHUB_SOURCE_COMPLETE_ONCE;
    throw new Error("테스트용 source job 완료 기록 실패");
  }
}

function newJob(input: GitHubSourceJobInput, options: EnqueueOptions = {}): GitHubSourceJobRecord {
  assertCredentialFreePayload(input);
  const now = timestamp(options.now);
  return {
    id: input.jobId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    owner: input.owner,
    status: "queued",
    input: clone(input),
    attemptCount: 0,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    manualRetryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export class MemoryGitHubSourceJobRepository implements GitHubSourceJobRepository {
  constructor(
    private readonly jobs = new Map<string, GitHubSourceJobRecord>(),
    private readonly capabilities = new Map<string, GitHubConnectorCapabilityRecord>(),
    private readonly applyStageChunks = new Map<string, Map<number, GitHubApplyStageChunk>>(),
  ) {}

  async enqueue(input: GitHubSourceJobInput, options: EnqueueOptions = {}) {
    const existing = [...this.jobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) return { job: clone(existing), created: false };
    const repositoryId = applyRepositoryId(input);
    const active = repositoryId
      ? [...this.jobs.values()].find((job) =>
          job.kind === "apply"
          && job.input.selectedRepositoryIds[0] === repositoryId
          && isActiveStatus(job.status))
      : undefined;
    if (active) return { job: clone(active), created: false };
    const job = newJob(input, options);
    this.jobs.set(job.id, job);
    return { job: clone(job), created: true };
  }

  async get(jobId: string) {
    const job = this.jobs.get(jobId);
    return job ? clone(job) : null;
  }

  async list() {
    return [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  async claim(options: ClaimOptions) {
    const capability = this.capabilities.get(options.connectorId);
    if (capability?.status !== "online") return null;
    const now = timestamp(options.now);
    for (const job of [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const claimable = job.status === "queued" || (isLeaseStatus(job.status) && isExpired(job, now));
      if (!claimable) continue;
      if (job.attemptCount >= job.maxAttempts) {
        if (isLeaseStatus(job.status)) {
          job.status = "failed";
          job.errorCode = "retry_exhausted";
          job.errorMessage = "최대 GitHub source 재시도 횟수를 초과했습니다.";
          job.leaseOwner = undefined;
          job.leaseExpiresAt = undefined;
          job.completedAt = now;
          job.updatedAt = now;
          this.applyStageChunks.delete(job.id);
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
    const stored = requireJob(this.jobs.get(input.jobId) ?? null);
    assertLease(stored, input.connectorId, now);
    stored.leaseExpiresAt = expiresAt(now, input.leaseDurationMs);
    stored.updatedAt = now;
    return clone(stored);
  }

  async markRunning(input: LeaseMutation) {
    const now = timestamp(input.now);
    const stored = requireJob(this.jobs.get(input.jobId) ?? null);
    assertLease(stored, input.connectorId, now);
    if (stored.status !== "leased") {
      throw new GitHubSourceRepositoryError("invalid_input", "leased 작업만 running으로 전환할 수 있습니다.");
    }
    assertTransition(stored.status, "running");
    stored.status = "running";
    stored.startedAt ??= now;
    stored.updatedAt = now;
    return clone(stored);
  }

  async complete(input: CompleteInput) {
    const now = timestamp(input.now);
    const stored = requireJob(this.jobs.get(input.jobId) ?? null);
    assertLease(stored, input.connectorId, now);
    const result = validateGitHubSourceJobResult(input.result, stored);
    failCompletionOnceForTest(input.jobId);
    assertTransition(stored.status, "completed");
    stored.status = "completed";
    stored.result = clone(result);
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.errorCode = undefined;
    stored.errorMessage = undefined;
    stored.updatedAt = now;
    stored.completedAt = now;
    this.applyStageChunks.delete(stored.id);
    return clone(stored);
  }

  async fail(input: FailInput) {
    assertCredentialFreePayload(input);
    const now = timestamp(input.now);
    const stored = requireJob(this.jobs.get(input.jobId) ?? null);
    assertLease(stored, input.connectorId, now);
    const nextStatus: GitHubSourceJobStatus =
      input.retryable && stored.attemptCount < stored.maxAttempts ? "queued" : "failed";
    assertTransition(stored.status, nextStatus);
    stored.status = nextStatus;
    stored.errorCode = input.errorCode;
    stored.errorMessage = input.errorMessage.slice(0, 1_000);
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = nextStatus === "failed" ? now : undefined;
    if (nextStatus === "failed") this.applyStageChunks.delete(stored.id);
    return clone(stored);
  }

  async cancel(jobId: string, nowValue?: string) {
    const now = timestamp(nowValue);
    const stored = requireJob(this.jobs.get(jobId) ?? null);
    if (stored.status === "cancelled") return clone(stored);
    assertTransition(stored.status, "cancelled");
    stored.status = "cancelled";
    stored.errorCode = "cancelled";
    stored.errorMessage = "사용자가 GitHub source 작업을 취소했습니다.";
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = now;
    this.applyStageChunks.delete(stored.id);
    return clone(stored);
  }

  async retry(jobId: string, nowValue?: string) {
    const now = timestamp(nowValue);
    const stored = requireJob(this.jobs.get(jobId) ?? null);
    if (stored.status !== "failed") {
      throw new GitHubSourceRepositoryError("invalid_input", "실패한 GitHub source 작업만 다시 시도할 수 있습니다.");
    }
    if (stored.manualRetryCount >= MAX_MANUAL_GITHUB_SOURCE_RETRIES) {
      throw new GitHubSourceRepositoryError("retry_exhausted", "수동 재시도 한도를 초과했습니다.");
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

  async recordCapability(input: CapabilityInput) {
    assertCredentialFreePayload(input);
    const now = timestamp(input.now);
    const record: GitHubConnectorCapabilityRecord = {
      connectorId: input.connectorId,
      capability: "github-source",
      status: input.status,
      errorCode: input.errorCode,
      accountLogin: input.accountLogin,
      host: input.host,
      rateLimitResetAt: input.rateLimitResetAt,
      message: input.message?.slice(0, 300),
      checkedAt: input.checkedAt,
      lastSeenAt: now,
    };
    this.capabilities.set(input.connectorId, record);
    return clone(record);
  }

  async getCapability(connectorId: string) {
    const record = this.capabilities.get(connectorId);
    return record ? clone(record) : null;
  }

  async listCapabilities() {
    return [...this.capabilities.values()]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map(clone);
  }

  async putApplyStageChunk(chunk: GitHubApplyStageChunk) {
    const chunks = this.applyStageChunks.get(chunk.jobId) ?? new Map<number, GitHubApplyStageChunk>();
    const existingTotal = chunks.values().next().value?.totalChunks;
    if (existingTotal !== undefined && existingTotal !== chunk.totalChunks) {
      throw new GitHubSourceRepositoryError("invalid_result", "기존 Apply stage와 totalChunks가 다릅니다.");
    }
    const existing = chunks.get(chunk.chunkIndex);
    if (existing && existing.checksum !== chunk.checksum) {
      throw new GitHubSourceRepositoryError("invalid_result", "같은 Apply stage 순서에 다른 checksum을 덮어쓸 수 없습니다.");
    }
    if (!existing && chunk.chunkIndex !== chunks.size) {
      throw new GitHubSourceRepositoryError("invalid_result", "Apply stage chunk는 순서대로 업로드해야 합니다.");
    }
    chunks.set(chunk.chunkIndex, clone(chunk));
    this.applyStageChunks.set(chunk.jobId, chunks);
    return chunks.size;
  }

  async listApplyStageChunks(jobId: string) {
    return [...(this.applyStageChunks.get(jobId)?.values() ?? [])]
      .sort((left, right) => left.chunkIndex - right.chunkIndex)
      .map(clone);
  }

  async deleteApplyStageChunks(jobId: string) {
    this.applyStageChunks.delete(jobId);
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

const asD1Job = (row: D1Row): GitHubSourceJobRecord => ({
  id: String(row.id),
  idempotencyKey: String(row.idempotency_key),
  kind: String(row.kind) as GitHubSourceJobRecord["kind"],
  owner: "coreline-ai",
  status: String(row.status) as GitHubSourceJobStatus,
  input: parseJson<GitHubSourceJobInput>(row.input_json)!,
  result: parseJson<GitHubSourceJobResult>(row.result_json),
  attemptCount: Number(row.attempt_count),
  maxAttempts: Number(row.max_attempts),
  manualRetryCount: Number(row.manual_retry_count),
  lastManualRetryAt: row.last_manual_retry_at ? String(row.last_manual_retry_at) : undefined,
  leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
  leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
  errorCode: row.error_code ? String(row.error_code) as GitHubSourceErrorCode : undefined,
  errorMessage: row.error_message ? String(row.error_message) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  startedAt: row.started_at ? String(row.started_at) : undefined,
  completedAt: row.completed_at ? String(row.completed_at) : undefined,
});

const asD1Capability = (row: D1Row): GitHubConnectorCapabilityRecord => ({
  connectorId: String(row.connector_id),
  capability: "github-source",
  status: String(row.status) as GitHubConnectorCapabilityRecord["status"],
  errorCode: row.error_code ? String(row.error_code) as GitHubSourceErrorCode : undefined,
  accountLogin: row.account_login ? String(row.account_login) : undefined,
  host: row.host ? String(row.host) : undefined,
  rateLimitResetAt: row.rate_limit_reset_at ? String(row.rate_limit_reset_at) : undefined,
  message: row.message ? String(row.message) : undefined,
  checkedAt: String(row.checked_at),
  lastSeenAt: String(row.last_seen_at),
});

export const githubSourceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS github_source_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, repository_id TEXT, status TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, manual_retry_count INTEGER NOT NULL DEFAULT 0, last_manual_retry_at TEXT, lease_owner TEXT, lease_expires_at TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS github_connector_capabilities (connector_id TEXT NOT NULL, capability TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, account_login TEXT, host TEXT, rate_limit_reset_at TEXT, message TEXT, checked_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (connector_id, capability))`,
  `CREATE TABLE IF NOT EXISTS github_apply_stage_chunks (job_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, total_chunks INTEGER NOT NULL, checksum TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (job_id, chunk_index))`,
  `CREATE INDEX IF NOT EXISTS github_source_jobs_claim_idx ON github_source_jobs(status, lease_expires_at, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS github_source_jobs_idempotency_unique ON github_source_jobs(idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS github_connector_capabilities_seen_idx ON github_connector_capabilities(status, last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS github_apply_stage_chunks_job_idx ON github_apply_stage_chunks(job_id, chunk_index)`,
] as const;

export class D1GitHubSourceJobRepository implements GitHubSourceJobRepository {
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly db: D1Database) {}

  private async ready() {
    this.readyPromise ??= (async () => {
      await this.db.batch(githubSourceSchemaStatements.map((statement) => this.db.prepare(statement)));
      const info = await this.db.prepare("PRAGMA table_info(github_source_jobs)").all<{ name: string }>();
      if (!info.results.some((column) => String(column.name) === "repository_id")) {
        await this.db.prepare("ALTER TABLE github_source_jobs ADD COLUMN repository_id TEXT").run()
          .catch((error) => {
            if (!String(error).toLowerCase().includes("duplicate column")) throw error;
          });
      }
      await this.db.prepare(`UPDATE github_source_jobs
        SET repository_id = json_extract(input_json, '$.selectedRepositoryIds[0]')
        WHERE kind = 'apply' AND repository_id IS NULL`).run();
      await this.db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS github_source_jobs_active_apply_unique
        ON github_source_jobs(repository_id)
        WHERE kind = 'apply' AND status IN ('queued', 'leased', 'running')`).run();
    })();
    await this.readyPromise;
  }

  async enqueue(input: GitHubSourceJobInput, options: EnqueueOptions = {}) {
    await this.ready();
    const job = newJob(input, options);
    const outcome = await this.db.prepare(`INSERT OR IGNORE INTO github_source_jobs
      (id, idempotency_key, kind, owner, repository_id, status, input_json, result_json, attempt_count,
       max_attempts, manual_retry_count, last_manual_retry_at, lease_owner, lease_expires_at,
       error_code, error_message, created_at, updated_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, NULL, 0, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`)
      .bind(
        job.id,
        job.idempotencyKey,
        job.kind,
        job.owner,
        applyRepositoryId(job.input) ?? null,
        JSON.stringify(job.input),
        job.maxAttempts,
        job.createdAt,
        job.updatedAt,
      )
      .run();
    let stored = await this.getByIdempotencyKey(job.idempotencyKey);
    if (!stored && job.kind === "apply") {
      const row = await this.db.prepare(`SELECT * FROM github_source_jobs
        WHERE kind = 'apply' AND repository_id = ? AND status IN ('queued', 'leased', 'running')
        ORDER BY created_at LIMIT 1`).bind(applyRepositoryId(job.input)).first<D1Row>();
      stored = row ? asD1Job(row) : null;
    }
    return { job: requireJob(stored), created: Number(outcome.meta.changes ?? 0) === 1 };
  }

  async get(jobId: string) {
    await this.ready();
    const row = await this.db.prepare("SELECT * FROM github_source_jobs WHERE id = ? LIMIT 1")
      .bind(jobId).first<D1Row>();
    return row ? asD1Job(row) : null;
  }

  private async getByIdempotencyKey(idempotencyKey: string) {
    const row = await this.db.prepare("SELECT * FROM github_source_jobs WHERE idempotency_key = ? LIMIT 1")
      .bind(idempotencyKey).first<D1Row>();
    return row ? asD1Job(row) : null;
  }

  async list() {
    await this.ready();
    const result = await this.db.prepare("SELECT * FROM github_source_jobs ORDER BY created_at").all<D1Row>();
    return result.results.map(asD1Job);
  }

  async claim(options: ClaimOptions) {
    await this.ready();
    const capability = await this.getCapability(options.connectorId);
    if (capability?.status !== "online") return null;
    const now = timestamp(options.now);
    await this.db.batch([
      this.db.prepare(`DELETE FROM github_apply_stage_chunks WHERE job_id IN (
        SELECT id FROM github_source_jobs
        WHERE status IN ('leased', 'running') AND lease_expires_at <= ? AND attempt_count >= max_attempts
      )`).bind(now),
      this.db.prepare(`UPDATE github_source_jobs SET status = 'failed', error_code = 'retry_exhausted', error_message = '최대 GitHub source 재시도 횟수를 초과했습니다.', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
        WHERE status IN ('leased', 'running') AND lease_expires_at <= ? AND attempt_count >= max_attempts`)
        .bind(now, now, now),
    ]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = await this.db.prepare(`SELECT * FROM github_source_jobs
        WHERE attempt_count < max_attempts AND (status = 'queued' OR (status IN ('leased', 'running') AND lease_expires_at <= ?))
        ORDER BY created_at LIMIT 1`).bind(now).first<D1Row>();
      if (!row) return null;
      const job = asD1Job(row);
      const outcome = await this.db.prepare(`UPDATE github_source_jobs
        SET status = 'leased', attempt_count = attempt_count + 1, lease_owner = ?, lease_expires_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND attempt_count = ? AND (status = 'queued' OR (status IN ('leased', 'running') AND lease_expires_at <= ?))`)
        .bind(options.connectorId, expiresAt(now, options.leaseDurationMs), now, job.id, job.attemptCount, now).run();
      if (Number(outcome.meta.changes ?? 0) === 1) return requireJob(await this.get(job.id));
    }
    return null;
  }

  private async classifyLeaseFailure(jobId: string, connectorId: string, now: string): Promise<never> {
    const job = requireJob(await this.get(jobId));
    assertLease(job, connectorId, now);
    throw new GitHubSourceRepositoryError("lease_conflict", "동시 상태 변경으로 Lease 갱신에 실패했습니다.");
  }

  async renewLease(input: RenewLeaseInput) {
    await this.ready();
    const now = timestamp(input.now);
    const outcome = await this.db.prepare(`UPDATE github_source_jobs SET lease_expires_at = ?, updated_at = ?
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
    const outcome = await this.db.prepare(`UPDATE github_source_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status = 'leased' AND lease_expires_at > ?`)
      .bind(now, now, input.jobId, input.connectorId, now).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      const job = requireJob(await this.get(input.jobId));
      assertLease(job, input.connectorId, now);
      throw new GitHubSourceRepositoryError("invalid_input", "leased 작업만 running으로 전환할 수 있습니다.");
    }
    return requireJob(await this.get(input.jobId));
  }

  async complete(input: CompleteInput) {
    await this.ready();
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.connectorId, now);
    const result = validateGitHubSourceJobResult(input.result, job);
    failCompletionOnceForTest(input.jobId);
    const [outcome] = await this.db.batch([
      this.db.prepare(`UPDATE github_source_jobs
        SET status = 'completed', result_json = ?, lease_owner = NULL, lease_expires_at = NULL,
            error_code = NULL, error_message = NULL, updated_at = ?, completed_at = ?
        WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
        .bind(JSON.stringify(result), now, now, input.jobId, input.connectorId, now),
      this.db.prepare("DELETE FROM github_apply_stage_chunks WHERE job_id = ?").bind(input.jobId),
    ]);
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.connectorId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async fail(input: FailInput) {
    await this.ready();
    assertCredentialFreePayload(input);
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.connectorId, now);
    const nextStatus: GitHubSourceJobStatus =
      input.retryable && job.attemptCount < job.maxAttempts ? "queued" : "failed";
    assertTransition(job.status, nextStatus);
    const statements = [this.db.prepare(`UPDATE github_source_jobs
      SET status = ?, error_code = ?, error_message = ?, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
      .bind(nextStatus, input.errorCode, input.errorMessage.slice(0, 1_000), now, nextStatus === "failed" ? now : null, input.jobId, input.connectorId, now)];
    if (nextStatus === "failed") {
      statements.push(this.db.prepare("DELETE FROM github_apply_stage_chunks WHERE job_id = ?").bind(input.jobId));
    }
    const [outcome] = await this.db.batch(statements);
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.connectorId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async cancel(jobId: string, nowValue?: string) {
    await this.ready();
    const now = timestamp(nowValue);
    const [outcome] = await this.db.batch([
      this.db.prepare(`UPDATE github_source_jobs
        SET status = 'cancelled', error_code = 'cancelled', error_message = '사용자가 GitHub source 작업을 취소했습니다.', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
        WHERE id = ? AND status IN ('queued', 'leased', 'running')`)
        .bind(now, now, jobId),
      this.db.prepare("DELETE FROM github_apply_stage_chunks WHERE job_id = ?").bind(jobId),
    ]);
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
      throw new GitHubSourceRepositoryError("invalid_input", "실패한 GitHub source 작업만 다시 시도할 수 있습니다.");
    }
    if (job.manualRetryCount >= MAX_MANUAL_GITHUB_SOURCE_RETRIES) {
      throw new GitHubSourceRepositoryError("retry_exhausted", "수동 재시도 한도를 초과했습니다.");
    }
    const outcome = await this.db.prepare(`UPDATE github_source_jobs
      SET status = 'queued', result_json = NULL, attempt_count = 0,
          manual_retry_count = manual_retry_count + 1, last_manual_retry_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, error_message = NULL,
          started_at = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'failed' AND manual_retry_count < ?`)
      .bind(now, now, jobId, MAX_MANUAL_GITHUB_SOURCE_RETRIES).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      throw new GitHubSourceRepositoryError("lease_conflict", "재시도 상태가 동시에 변경되었습니다.");
    }
    return requireJob(await this.get(jobId));
  }

  async recordCapability(input: CapabilityInput) {
    await this.ready();
    assertCredentialFreePayload(input);
    const now = timestamp(input.now);
    await this.db.prepare(`INSERT INTO github_connector_capabilities
      (connector_id, capability, status, error_code, account_login, host,
       rate_limit_reset_at, message, checked_at, last_seen_at)
      VALUES (?, 'github-source', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, capability) DO UPDATE SET status=excluded.status,
        error_code=excluded.error_code, account_login=excluded.account_login, host=excluded.host,
        rate_limit_reset_at=excluded.rate_limit_reset_at, message=excluded.message,
        checked_at=excluded.checked_at, last_seen_at=excluded.last_seen_at`)
      .bind(
        input.connectorId,
        input.status,
        input.errorCode ?? null,
        input.accountLogin ?? null,
        input.host ?? null,
        input.rateLimitResetAt ?? null,
        input.message?.slice(0, 300) ?? null,
        input.checkedAt,
        now,
      ).run();
    return requireCapability(await this.getCapability(input.connectorId));
  }

  async getCapability(connectorId: string) {
    await this.ready();
    const row = await this.db.prepare(`SELECT * FROM github_connector_capabilities
      WHERE connector_id = ? AND capability = 'github-source' LIMIT 1`)
      .bind(connectorId).first<D1Row>();
    return row ? asD1Capability(row) : null;
  }

  async listCapabilities() {
    await this.ready();
    const result = await this.db.prepare("SELECT * FROM github_connector_capabilities ORDER BY last_seen_at DESC")
      .all<D1Row>();
    return result.results.map(asD1Capability);
  }

  async putApplyStageChunk(chunk: GitHubApplyStageChunk) {
    await this.ready();
    const existingTotal = await this.db.prepare(
      "SELECT total_chunks FROM github_apply_stage_chunks WHERE job_id = ? LIMIT 1",
    ).bind(chunk.jobId).first<{ total_chunks: number }>();
    if (existingTotal && Number(existingTotal.total_chunks) !== chunk.totalChunks) {
      throw new GitHubSourceRepositoryError("invalid_result", "기존 Apply stage와 totalChunks가 다릅니다.");
    }
    const existing = await this.db.prepare(
      "SELECT checksum FROM github_apply_stage_chunks WHERE job_id = ? AND chunk_index = ? LIMIT 1",
    ).bind(chunk.jobId, chunk.chunkIndex).first<{ checksum: string }>();
    if (existing && String(existing.checksum) !== chunk.checksum) {
      throw new GitHubSourceRepositoryError("invalid_result", "같은 Apply stage 순서에 다른 checksum을 덮어쓸 수 없습니다.");
    }
    const countBefore = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM github_apply_stage_chunks WHERE job_id = ?",
    ).bind(chunk.jobId).first<{ count: number }>();
    if (!existing && chunk.chunkIndex !== Number(countBefore?.count ?? 0)) {
      throw new GitHubSourceRepositoryError("invalid_result", "Apply stage chunk는 순서대로 업로드해야 합니다.");
    }
    await this.db.prepare(`INSERT OR REPLACE INTO github_apply_stage_chunks
      (job_id, chunk_index, total_chunks, checksum, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        chunk.jobId,
        chunk.chunkIndex,
        chunk.totalChunks,
        chunk.checksum,
        JSON.stringify(chunk.documents),
        new Date().toISOString(),
      ).run();
    const count = await this.db.prepare(
      "SELECT COUNT(*) AS count FROM github_apply_stage_chunks WHERE job_id = ?",
    ).bind(chunk.jobId).first<{ count: number }>();
    return Number(count?.count ?? 0);
  }

  async listApplyStageChunks(jobId: string) {
    await this.ready();
    const result = await this.db.prepare(
      "SELECT * FROM github_apply_stage_chunks WHERE job_id = ? ORDER BY chunk_index",
    ).bind(jobId).all<D1Row>();
    return result.results.map((row) => ({
      jobId: String(row.job_id),
      chunkIndex: Number(row.chunk_index),
      totalChunks: Number(row.total_chunks),
      checksum: String(row.checksum),
      documents: JSON.parse(String(row.payload_json)) as GitHubApplyStageChunk["documents"],
    }));
  }

  async deleteApplyStageChunks(jobId: string) {
    await this.ready();
    await this.db.prepare("DELETE FROM github_apply_stage_chunks WHERE job_id = ?").bind(jobId).run();
  }
}

function requireCapability(capability: GitHubConnectorCapabilityRecord | null) {
  if (!capability) throw new GitHubSourceRepositoryError("invalid_input", "GitHub capability를 찾을 수 없습니다.");
  return capability;
}

const memoryKey = "__AI_ATLAS_GITHUB_SOURCE_JOB_STORE__";
function defaultMemoryRepository() {
  const root = globalThis as typeof globalThis & {
    [memoryKey]?: MemoryGitHubSourceJobRepository;
  };
  root[memoryKey] ??= new MemoryGitHubSourceJobRepository();
  return root[memoryKey];
}

async function database() {
  if (process.env.ATLAS_MEMORY_STORAGE === "true") return null;
  if (process.env.ATLAS_TEST_MODE === "true") {
    const testDatabase = (globalThis as typeof globalThis & {
      __AI_ATLAS_TEST_D1__?: D1Database;
    }).__AI_ATLAS_TEST_D1__;
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

export const createMemoryGitHubSourceJobRepository = () => new MemoryGitHubSourceJobRepository();
export const createD1GitHubSourceJobRepository = (db: D1Database) =>
  new D1GitHubSourceJobRepository(db);

export async function getGitHubSourceJobRepository(): Promise<GitHubSourceJobRepository> {
  const db = await database();
  return db ? new D1GitHubSourceJobRepository(db) : defaultMemoryRepository();
}
