import {
  canTransitionEnrichmentJob,
  type RuntimeStatusRecord,
  type RuntimeStatusKind,
  type CodexRuntimeState,
  type RuntimeRunTelemetry,
  type EnrichmentErrorCode,
  type EnrichmentJobInput,
  type EnrichmentJobRecord,
  type EnrichmentJobStatus,
  type EnrichmentResult,
} from "../llm/enrichment-contracts";
import { stableKey } from "../markdown/normalize";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 60_000;
export const MAX_MANUAL_ENRICHMENT_RETRIES = 2;

type EnqueueOptions = {
  now?: string;
  maxAttempts?: number;
};

type ClaimOptions = {
  runtimeId: string;
  leaseDurationMs?: number;
  providerVersion?: string;
  now?: string;
};

type LeaseMutation = {
  jobId: string;
  runtimeId: string;
  now?: string;
};

type RenewLeaseInput = LeaseMutation & {
  leaseDurationMs?: number;
};

type CompleteInput = LeaseMutation & {
  currentDocumentHash: string;
  result: EnrichmentResult;
};

type FailInput = LeaseMutation & {
  errorCode: EnrichmentErrorCode;
  errorMessage: string;
  retryable: boolean;
};

type RuntimeStatusInput = RuntimeRunTelemetry & {
  runtimeId: string;
  status: RuntimeStatusKind;
  version: string;
  runtimeState?: CodexRuntimeState;
  runtimeMessage?: string;
  currentJobId?: string;
  now?: string;
};

export type EnqueueEnrichmentJobResult = {
  job: EnrichmentJobRecord;
  created: boolean;
};

export type EnrichmentJobStatusCounts = Record<EnrichmentJobStatus, number>;

const emptyStatusCounts = (): EnrichmentJobStatusCounts => ({
  queued: 0,
  leased: 0,
  running: 0,
  completed: 0,
  warning: 0,
  failed: 0,
  stale: 0,
  cancelled: 0,
});

export interface EnrichmentJobRepository {
  enqueue(input: EnrichmentJobInput, options?: EnqueueOptions): Promise<EnqueueEnrichmentJobResult>;
  get(jobId: string): Promise<EnrichmentJobRecord | null>;
  list(documentId?: string, limit?: number): Promise<EnrichmentJobRecord[]>;
  statusCounts(providerVersion?: string): Promise<EnrichmentJobStatusCounts>;
  claim(options: ClaimOptions): Promise<EnrichmentJobRecord | null>;
  renewLease(input: RenewLeaseInput): Promise<EnrichmentJobRecord>;
  markRunning(input: LeaseMutation): Promise<EnrichmentJobRecord>;
  complete(input: CompleteInput): Promise<EnrichmentJobRecord>;
  fail(input: FailInput): Promise<EnrichmentJobRecord>;
  cancel(jobId: string, now?: string): Promise<EnrichmentJobRecord>;
  retry(jobId: string, now?: string): Promise<EnrichmentJobRecord>;
  recordRuntimeStatus(input: RuntimeStatusInput): Promise<RuntimeStatusRecord>;
  listRuntimeStatuses(): Promise<RuntimeStatusRecord[]>;
  markDocumentStale(
    documentId: string,
    currentDocumentHash: string,
    now?: string,
    includeCurrentHash?: boolean,
  ): Promise<number>;
  deleteForDocument(documentId: string): Promise<number>;
}

export class EnrichmentRepositoryError extends Error {
  constructor(
    readonly code: EnrichmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EnrichmentRepositoryError";
  }
}

const timestamp = (value?: string) => value ?? new Date().toISOString();
const expiresAt = (now: string, duration = DEFAULT_LEASE_MS) =>
  new Date(Date.parse(now) + Math.max(1_000, duration)).toISOString();
const isExpired = (job: EnrichmentJobRecord, now: string) =>
  !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.parse(now);
const isLeaseStatus = (status: EnrichmentJobStatus) =>
  status === "leased" || status === "running";
const clone = <T>(value: T): T => structuredClone(value);

function requireJob(job: EnrichmentJobRecord | null): EnrichmentJobRecord {
  if (!job) throw new EnrichmentRepositoryError("invalid_input", "보강 작업을 찾을 수 없습니다.");
  return job;
}

function assertLease(job: EnrichmentJobRecord, runtimeId: string, now: string) {
  if (!isLeaseStatus(job.status) || job.leaseOwner !== runtimeId) {
    throw new EnrichmentRepositoryError(
      "lease_conflict",
      "현재 통합 런타임이 소유한 Lease가 아닙니다.",
    );
  }
  if (isExpired(job, now)) {
    throw new EnrichmentRepositoryError("lease_expired", "보강 작업 Lease가 만료되었습니다.");
  }
}

function assertTransition(from: EnrichmentJobStatus, to: EnrichmentJobStatus) {
  if (!canTransitionEnrichmentJob(from, to)) {
    throw new EnrichmentRepositoryError(
      "invalid_input",
      `허용되지 않은 보강 작업 상태 전이입니다: ${from} -> ${to}`,
    );
  }
}

function newJob(input: EnrichmentJobInput, options: EnqueueOptions = {}): EnrichmentJobRecord {
  const now = timestamp(options.now);
  return {
    id: input.jobId,
    idempotencyKey: input.idempotencyKey,
    documentId: input.document.id,
    documentHash: input.document.hash,
    parserVersion: input.document.parserVersion,
    provider: input.provider,
    providerVersion: input.providerVersion,
    promptVersion: input.promptVersion,
    status: "queued",
    input: clone(input),
    attemptCount: 0,
    maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    manualRetryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export class MemoryEnrichmentJobRepository implements EnrichmentJobRepository {
  constructor(
    private readonly jobs = new Map<string, EnrichmentJobRecord>(),
    private readonly heartbeats = new Map<string, RuntimeStatusRecord>(),
  ) {}

  async enqueue(input: EnrichmentJobInput, options: EnqueueOptions = {}) {
    const existing = [...this.jobs.values()].find(
      (job) => job.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return { job: clone(existing), created: false };
    const job = newJob(input, options);
    this.jobs.set(job.id, job);
    return { job: clone(job), created: true };
  }

  async get(jobId: string) {
    const job = this.jobs.get(jobId);
    return job ? clone(job) : null;
  }

  async list(documentId?: string, limit?: number) {
    const rows = [...this.jobs.values()]
      .filter((job) => !documentId || job.documentId === documentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
    return limit ? rows.slice(-Math.max(1, Math.floor(limit))) : rows;
  }

  async statusCounts(providerVersion?: string) {
    const counts = emptyStatusCounts();
    for (const job of this.jobs.values()) {
      if (providerVersion && job.providerVersion !== providerVersion) continue;
      counts[job.status] += 1;
    }
    return counts;
  }

  async claim(options: ClaimOptions) {
    const now = timestamp(options.now);
    for (const job of [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const claimable =
        job.status === "queued" || (isLeaseStatus(job.status) && isExpired(job, now));
      if (!claimable || (options.providerVersion && job.providerVersion !== options.providerVersion)) continue;
      if (job.attemptCount >= job.maxAttempts) {
        if (isLeaseStatus(job.status)) {
          job.status = "failed";
          job.errorCode = "retry_exhausted";
          job.errorMessage = "최대 보강 재시도 횟수를 초과했습니다.";
          job.leaseOwner = undefined;
          job.leaseExpiresAt = undefined;
          job.completedAt = now;
          job.updatedAt = now;
        }
        continue;
      }
      assertTransition(job.status, "leased");
      job.status = "leased";
      job.attemptCount += 1;
      job.leaseOwner = options.runtimeId;
      job.leaseExpiresAt = expiresAt(now, options.leaseDurationMs);
      job.updatedAt = now;
      job.errorCode = undefined;
      job.errorMessage = undefined;
      return clone(job);
    }
    return null;
  }

  async renewLease(input: RenewLeaseInput) {
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.runtimeId, now);
    const stored = requireJob(this.jobs.get(job.id) ?? null);
    stored.leaseExpiresAt = expiresAt(now, input.leaseDurationMs);
    stored.updatedAt = now;
    return clone(stored);
  }

  async markRunning(input: LeaseMutation) {
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.runtimeId, now);
    if (job.status !== "leased") {
      throw new EnrichmentRepositoryError("invalid_input", "leased 작업만 running으로 전환할 수 있습니다.");
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
    assertLease(job, input.runtimeId, now);
    const stored = requireJob(this.jobs.get(job.id) ?? null);
    const nextStatus: EnrichmentJobStatus =
      input.currentDocumentHash === job.documentHash ? input.result.status : "stale";
    assertTransition(job.status, nextStatus);
    stored.status = nextStatus;
    stored.result = nextStatus === "stale" ? undefined : clone(input.result);
    stored.errorCode = nextStatus === "stale" ? "document_stale" : undefined;
    stored.errorMessage =
      nextStatus === "stale" ? "문서 해시가 변경되어 보강 결과를 적용하지 않았습니다." : undefined;
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = now;
    return clone(stored);
  }

  async fail(input: FailInput) {
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.runtimeId, now);
    const retry = input.retryable && job.attemptCount < job.maxAttempts;
    const nextStatus: EnrichmentJobStatus = retry ? "queued" : "failed";
    assertTransition(job.status, nextStatus);
    const stored = requireJob(this.jobs.get(job.id) ?? null);
    stored.status = nextStatus;
    stored.errorCode = input.errorCode;
    stored.errorMessage = input.errorMessage.slice(0, 1_000);
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = retry ? undefined : now;
    return clone(stored);
  }

  async cancel(jobId: string, nowValue?: string) {
    const now = timestamp(nowValue);
    const stored = requireJob(this.jobs.get(jobId) ?? null);
    if (stored.status === "cancelled") return clone(stored);
    assertTransition(stored.status, "cancelled");
    stored.status = "cancelled";
    stored.errorCode = "cancelled";
    stored.errorMessage = "사용자가 보강 작업을 취소했습니다.";
    stored.leaseOwner = undefined;
    stored.leaseExpiresAt = undefined;
    stored.updatedAt = now;
    stored.completedAt = now;
    return clone(stored);
  }

  async retry(jobId: string, nowValue?: string) {
    const now = timestamp(nowValue);
    const stored = requireJob(this.jobs.get(jobId) ?? null);
    if (stored.status !== "failed" && stored.status !== "warning") {
      throw new EnrichmentRepositoryError("invalid_input", "실패 또는 경고 작업만 다시 시도할 수 있습니다.");
    }
    if (stored.manualRetryCount >= MAX_MANUAL_ENRICHMENT_RETRIES) {
      throw new EnrichmentRepositoryError("retry_exhausted", "수동 재시도 한도를 초과했습니다.");
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

  async recordRuntimeStatus(input: RuntimeStatusInput) {
    const now = timestamp(input.now);
    const previous = this.heartbeats.get(input.runtimeId);
    const heartbeat: RuntimeStatusRecord = {
      runtimeId: input.runtimeId,
      status: input.status,
      version: input.version,
      currentJobId: input.currentJobId,
      runtimeState: input.runtimeState,
      runtimeMessage: input.runtimeMessage,
      runMode: input.runMode,
      maxJobs: input.maxJobs,
      maxRuntimeMs: input.maxRuntimeMs,
      processedJobs: input.processedJobs,
      succeededJobs: input.succeededJobs,
      warningJobs: input.warningJobs,
      failedJobs: input.failedJobs,
      stopReason: input.stopReason,
      startedAt: previous?.startedAt ?? now,
      lastSeenAt: now,
    };
    this.heartbeats.set(input.runtimeId, heartbeat);
    return clone(heartbeat);
  }

  async listRuntimeStatuses() {
    return [...this.heartbeats.values()]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map(clone);
  }

  async markDocumentStale(
    documentId: string,
    currentDocumentHash: string,
    nowValue?: string,
    includeCurrentHash = false,
  ) {
    const now = timestamp(nowValue);
    let changes = 0;
    for (const job of this.jobs.values()) {
      if (
        job.documentId !== documentId ||
        (!includeCurrentHash && job.documentHash === currentDocumentHash) ||
        !canTransitionEnrichmentJob(job.status, "stale")
      ) continue;
      job.status = "stale";
      job.errorCode = "document_stale";
      job.errorMessage = "문서 해시가 변경되어 작업을 무효화했습니다.";
      job.leaseOwner = undefined;
      job.leaseExpiresAt = undefined;
      job.updatedAt = now;
      job.completedAt = now;
      changes += 1;
    }
    return changes;
  }

  async deleteForDocument(documentId: string) {
    let changes = 0;
    for (const [id, job] of this.jobs) {
      if (job.documentId !== documentId) continue;
      this.jobs.delete(id);
      changes += 1;
    }
    return changes;
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

const mergeRelationEvidence = (
  existing: EnrichmentResult["relations"][number]["evidence"] | undefined,
  incoming: EnrichmentResult["relations"][number]["evidence"],
) => [...new Map([...(existing ?? []), ...incoming]
  .map((item) => [`${item.blockId}\u0000${item.explanation}`, item] as const)).values()]
  .sort((left, right) => left.blockId.localeCompare(right.blockId)
    || left.explanation.localeCompare(right.explanation));

const mergeRelationNote = (existing: string | undefined, incoming: string) => {
  const notes = [...new Set([existing?.trim(), incoming.trim()].filter(Boolean) as string[])];
  return notes.sort((left, right) => right.length - left.length || left.localeCompare(right))[0] ?? "";
};

const asD1Job = (row: D1Row): EnrichmentJobRecord => ({
  id: String(row.id),
  idempotencyKey: String(row.idempotency_key),
  documentId: String(row.document_id),
  documentHash: String(row.document_hash),
  parserVersion: String(row.parser_version),
  provider: "codex",
  providerVersion: String(row.provider_version),
  promptVersion: String(row.prompt_version),
  status: String(row.status) as EnrichmentJobStatus,
  input: parseJson<EnrichmentJobInput>(row.input_json)!,
  result: parseJson<EnrichmentResult>(row.result_json),
  attemptCount: Number(row.attempt_count),
  maxAttempts: Number(row.max_attempts),
  manualRetryCount: Number(row.manual_retry_count ?? 0),
  lastManualRetryAt: row.last_manual_retry_at ? String(row.last_manual_retry_at) : undefined,
  leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
  leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined,
  errorCode: row.error_code ? String(row.error_code) as EnrichmentErrorCode : undefined,
  errorMessage: row.error_message ? String(row.error_message) : undefined,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  startedAt: row.started_at ? String(row.started_at) : undefined,
  completedAt: row.completed_at ? String(row.completed_at) : undefined,
});

const asD1RuntimeStatus = (row: D1Row): RuntimeStatusRecord => ({
  runtimeId: String(row.runtime_id),
  status: String(row.status) as RuntimeStatusKind,
  version: String(row.version),
  runtimeState: typeof row.runtime_state === "string"
    ? row.runtime_state as RuntimeStatusRecord["runtimeState"]
    : undefined,
  runtimeMessage: row.runtime_message ? String(row.runtime_message) : undefined,
  currentJobId: row.current_job_id ? String(row.current_job_id) : undefined,
  runMode: row.run_mode === "continuous" || row.run_mode === "bounded"
    ? row.run_mode
    : undefined,
  maxJobs: row.max_jobs === null || row.max_jobs === undefined ? undefined : Number(row.max_jobs),
  maxRuntimeMs: row.max_runtime_ms === null || row.max_runtime_ms === undefined
    ? undefined
    : Number(row.max_runtime_ms),
  processedJobs: row.processed_jobs === null || row.processed_jobs === undefined
    ? undefined
    : Number(row.processed_jobs),
  succeededJobs: row.succeeded_jobs === null || row.succeeded_jobs === undefined
    ? undefined
    : Number(row.succeeded_jobs),
  warningJobs: row.warning_jobs === null || row.warning_jobs === undefined
    ? undefined
    : Number(row.warning_jobs),
  failedJobs: row.failed_jobs === null || row.failed_jobs === undefined
    ? undefined
    : Number(row.failed_jobs),
  stopReason: typeof row.stop_reason === "string"
    ? row.stop_reason as RuntimeStatusRecord["stopReason"]
    : undefined,
  startedAt: String(row.started_at),
  lastSeenAt: String(row.last_seen_at),
});

export const enrichmentSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS enrichment_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL, document_hash TEXT NOT NULL, parser_version TEXT NOT NULL, provider TEXT NOT NULL, provider_version TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, lease_owner TEXT, lease_expires_at TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS runtime_status (runtime_id TEXT PRIMARY KEY, status TEXT NOT NULL, version TEXT NOT NULL, current_job_id TEXT, runtime_state TEXT, runtime_message TEXT, run_mode TEXT, max_jobs INTEGER, max_runtime_ms INTEGER, processed_jobs INTEGER, succeeded_jobs INTEGER, warning_jobs INTEGER, failed_jobs INTEGER, stop_reason TEXT, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_claim_idx ON enrichment_jobs(status, lease_expires_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_provider_claim_idx ON enrichment_jobs(provider_version, status, lease_expires_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_document_idx ON enrichment_jobs(document_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS runtime_status_seen_idx ON runtime_status(last_seen_at)`,
] as const;

export class D1EnrichmentJobRepository implements EnrichmentJobRepository {
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly db: D1Database) {}

  private async ready() {
    this.readyPromise ??= (async () => {
      await this.db.batch(enrichmentSchemaStatements.map((statement) => this.db.prepare(statement)));
      const info = await this.db.prepare("PRAGMA table_info(enrichment_jobs)").all<{ name: string }>();
      const columns = new Set(info.results.map((column) => String(column.name)));
      if (!columns.has("manual_retry_count")) {
        await this.db.prepare("ALTER TABLE enrichment_jobs ADD COLUMN manual_retry_count INTEGER NOT NULL DEFAULT 0").run()
          .catch((error) => {
            if (!String(error).toLowerCase().includes("duplicate column")) throw error;
          });
      }
      if (!columns.has("last_manual_retry_at")) {
        await this.db.prepare("ALTER TABLE enrichment_jobs ADD COLUMN last_manual_retry_at TEXT").run()
          .catch((error) => {
            if (!String(error).toLowerCase().includes("duplicate column")) throw error;
          });
      }
      const heartbeatInfo = await this.db.prepare("PRAGMA table_info(runtime_status)")
        .all<{ name: string }>();
      const heartbeatColumns = new Set(heartbeatInfo.results.map((column) => String(column.name)));
      const telemetryColumns = [
        ["runtime_state", "TEXT"],
        ["runtime_message", "TEXT"],
        ["run_mode", "TEXT"],
        ["max_jobs", "INTEGER"],
        ["max_runtime_ms", "INTEGER"],
        ["processed_jobs", "INTEGER"],
        ["succeeded_jobs", "INTEGER"],
        ["warning_jobs", "INTEGER"],
        ["failed_jobs", "INTEGER"],
        ["stop_reason", "TEXT"],
      ] as const;
      for (const [name, type] of telemetryColumns) {
        if (heartbeatColumns.has(name)) continue;
        await this.db.prepare(`ALTER TABLE runtime_status ADD COLUMN ${name} ${type}`).run()
          .catch((error) => {
            if (!String(error).toLowerCase().includes("duplicate column")) throw error;
          });
      }
      // Older local/remote D1 instances may have status written by the
      // previously separate process. Keep it as a read-only migration source
      // so the unified runtime continues to show the last meaningful state.
      const legacyTable = await this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connector_heartbeats' LIMIT 1",
      ).first<{ name: string }>();
      if (legacyTable) {
        const legacyInfo = await this.db.prepare("PRAGMA table_info(connector_heartbeats)")
          .all<{ name: string }>();
        const legacyColumns = new Set(legacyInfo.results.map((column) => String(column.name)));
        const column = (name: string, fallback = "NULL") => legacyColumns.has(name) ? name : fallback;
        await this.db.prepare(`INSERT OR REPLACE INTO runtime_status
          (runtime_id, status, version, current_job_id, runtime_state, runtime_message, run_mode,
           max_jobs, max_runtime_ms, processed_jobs, succeeded_jobs, warning_jobs, failed_jobs,
           stop_reason, started_at, last_seen_at)
          SELECT ${column("connector_id")}, ${column("status", "'offline'")}, ${column("version", "'legacy'")},
            ${column("current_job_id")}, ${column("runtime_state")}, ${column("runtime_message")},
            ${column("run_mode")}, ${column("max_jobs")}, ${column("max_runtime_ms")},
            ${column("processed_jobs")}, ${column("succeeded_jobs")}, ${column("warning_jobs")},
            ${column("failed_jobs")}, ${column("stop_reason")}, ${column("started_at", "CURRENT_TIMESTAMP")},
            ${column("last_seen_at", "CURRENT_TIMESTAMP")}
          FROM connector_heartbeats
          WHERE 1 = 1
          ON CONFLICT(runtime_id) DO UPDATE SET
            status=excluded.status, version=excluded.version, current_job_id=excluded.current_job_id,
            runtime_state=excluded.runtime_state, runtime_message=excluded.runtime_message,
            run_mode=excluded.run_mode, max_jobs=excluded.max_jobs, max_runtime_ms=excluded.max_runtime_ms,
            processed_jobs=excluded.processed_jobs, succeeded_jobs=excluded.succeeded_jobs,
            warning_jobs=excluded.warning_jobs, failed_jobs=excluded.failed_jobs,
            stop_reason=excluded.stop_reason, last_seen_at=excluded.last_seen_at
          WHERE excluded.last_seen_at > runtime_status.last_seen_at`).run();
      }
    })();
    await this.readyPromise;
  }

  async enqueue(input: EnrichmentJobInput, options: EnqueueOptions = {}) {
    await this.ready();
    const job = newJob(input, options);
    const outcome = await this.db.prepare(`INSERT OR IGNORE INTO enrichment_jobs
      (id, idempotency_key, document_id, document_hash, parser_version, provider, provider_version, prompt_version, status, input_json, result_json, attempt_count, max_attempts, manual_retry_count, last_manual_retry_at, lease_owner, lease_expires_at, error_code, error_message, created_at, updated_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`)
      .bind(job.id, job.idempotencyKey, job.documentId, job.documentHash, job.parserVersion, job.provider, job.providerVersion, job.promptVersion, job.status, JSON.stringify(job.input), job.maxAttempts, job.createdAt, job.updatedAt)
      .run();
    const stored = await this.getByIdempotencyKey(job.idempotencyKey);
    return { job: requireJob(stored), created: Number(outcome.meta.changes ?? 0) === 1 };
  }

  async get(jobId: string) {
    await this.ready();
    const row = await this.db.prepare("SELECT * FROM enrichment_jobs WHERE id = ? LIMIT 1")
      .bind(jobId)
      .first<D1Row>();
    return row ? asD1Job(row) : null;
  }

  private async getByIdempotencyKey(idempotencyKey: string) {
    const row = await this.db
      .prepare("SELECT * FROM enrichment_jobs WHERE idempotency_key = ? LIMIT 1")
      .bind(idempotencyKey)
      .first<D1Row>();
    return row ? asD1Job(row) : null;
  }

  async list(documentId?: string, limit?: number) {
    await this.ready();
    const safeLimit = limit ? Math.max(1, Math.floor(limit)) : undefined;
    const result = documentId
      ? safeLimit
        ? await this.db.prepare("SELECT * FROM enrichment_jobs WHERE document_id = ? ORDER BY created_at DESC LIMIT ?")
          .bind(documentId, safeLimit).all<D1Row>()
        : await this.db.prepare("SELECT * FROM enrichment_jobs WHERE document_id = ? ORDER BY created_at")
          .bind(documentId).all<D1Row>()
      : safeLimit
        ? await this.db.prepare("SELECT * FROM enrichment_jobs ORDER BY created_at DESC LIMIT ?")
          .bind(safeLimit).all<D1Row>()
        : await this.db.prepare("SELECT * FROM enrichment_jobs ORDER BY created_at").all<D1Row>();
    const jobs = result.results.map(asD1Job);
    return safeLimit ? jobs.sort((left, right) => left.createdAt.localeCompare(right.createdAt)) : jobs;
  }

  async statusCounts(providerVersion?: string) {
    await this.ready();
    const counts = emptyStatusCounts();
    const result = providerVersion
      ? await this.db.prepare("SELECT status, COUNT(*) AS count FROM enrichment_jobs WHERE provider_version = ? GROUP BY status")
        .bind(providerVersion).all<{ status: string; count: number }>()
      : await this.db.prepare("SELECT status, COUNT(*) AS count FROM enrichment_jobs GROUP BY status")
        .all<{ status: string; count: number }>();
    for (const row of result.results) {
      if (row.status in counts) counts[row.status as EnrichmentJobStatus] = Number(row.count);
    }
    return counts;
  }

  async claim(options: ClaimOptions) {
    await this.ready();
    const now = timestamp(options.now);
    await this.db.prepare(`UPDATE enrichment_jobs SET status = 'failed', error_code = 'retry_exhausted', error_message = '최대 보강 재시도 횟수를 초과했습니다.', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE status IN ('leased', 'running') AND lease_expires_at <= ? AND attempt_count >= max_attempts`)
      .bind(now, now, now).run();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const row = options.providerVersion
        ? await this.db.prepare(`SELECT * FROM enrichment_jobs
          WHERE provider_version = ? AND attempt_count < max_attempts
            AND (status = 'queued' OR (status IN ('leased', 'running') AND lease_expires_at <= ?))
          ORDER BY created_at LIMIT 1`).bind(options.providerVersion, now).first<D1Row>()
        : await this.db.prepare(`SELECT * FROM enrichment_jobs
          WHERE attempt_count < max_attempts AND (status = 'queued' OR (status IN ('leased', 'running') AND lease_expires_at <= ?))
          ORDER BY created_at LIMIT 1`).bind(now).first<D1Row>();
      if (!row) return null;
      const job = asD1Job(row);
      const nextExpiry = expiresAt(now, options.leaseDurationMs);
      const outcome = await this.db.prepare(`UPDATE enrichment_jobs
        SET status = 'leased', attempt_count = attempt_count + 1, lease_owner = ?, lease_expires_at = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ? AND attempt_count = ?
          AND (? IS NULL OR provider_version = ?)
          AND (status = 'queued' OR (status IN ('leased', 'running') AND lease_expires_at <= ?))`)
        .bind(
          options.runtimeId,
          nextExpiry,
          now,
          job.id,
          job.attemptCount,
          options.providerVersion ?? null,
          options.providerVersion ?? null,
          now,
        ).run();
      if (Number(outcome.meta.changes ?? 0) === 1) return requireJob(await this.get(job.id));
    }
    return null;
  }

  private async classifyLeaseFailure(jobId: string, runtimeId: string, now: string): Promise<never> {
    const job = requireJob(await this.get(jobId));
    assertLease(job, runtimeId, now);
    throw new EnrichmentRepositoryError("lease_conflict", "동시 상태 변경으로 Lease 갱신에 실패했습니다.");
  }

  async renewLease(input: RenewLeaseInput) {
    await this.ready();
    const now = timestamp(input.now);
    const outcome = await this.db.prepare(`UPDATE enrichment_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
      .bind(expiresAt(now, input.leaseDurationMs), now, input.jobId, input.runtimeId, now).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.runtimeId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async markRunning(input: LeaseMutation) {
    await this.ready();
    const now = timestamp(input.now);
    const outcome = await this.db.prepare(`UPDATE enrichment_jobs SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status = 'leased' AND lease_expires_at > ?`)
      .bind(now, now, input.jobId, input.runtimeId, now).run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      const job = requireJob(await this.get(input.jobId));
      assertLease(job, input.runtimeId, now);
      throw new EnrichmentRepositoryError("invalid_input", "leased 작업만 running으로 전환할 수 있습니다.");
    }
    return requireJob(await this.get(input.jobId));
  }

  async complete(input: CompleteInput) {
    await this.ready();
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.runtimeId, now);
    const nextStatus: EnrichmentJobStatus =
      input.currentDocumentHash === job.documentHash ? input.result.status : "stale";
    assertTransition(job.status, nextStatus);
    const existingResult = await this.db.prepare(`SELECT id, confidence, note, evidence_json
      FROM relations WHERE document_id = ? AND origin = 'codex'`)
      .bind(job.documentId).all<D1Row>();
    const existingById = new Map(existingResult.results.map((row) => [String(row.id), row]));
    const relationStatements = input.result.relations.map((relation) => {
      const relationId = `relation:${stableKey(`${job.documentId}:${relation.source}:${relation.target}:${relation.type}`)}`;
      const existing = existingById.get(relationId);
      const confidence = Math.max(Number(existing?.confidence ?? 0), relation.confidence);
      const note = mergeRelationNote(existing?.note ? String(existing.note) : undefined, relation.note);
      const evidence = mergeRelationEvidence(
        parseJson<EnrichmentResult["relations"][number]["evidence"]>(existing?.evidence_json),
        relation.evidence,
      );
      return this.db.prepare(`INSERT INTO relations
        (id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 'codex', ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM enrichment_jobs j INNER JOIN documents d ON d.id = j.document_id
          WHERE j.id = ? AND j.lease_owner = ? AND j.status IN ('leased', 'running')
            AND j.lease_expires_at > ? AND d.hash = j.document_hash
        )
        ON CONFLICT(id) DO UPDATE SET
          confidence=excluded.confidence,
          note=excluded.note,
          provider=excluded.provider,
          provider_version=excluded.provider_version,
          prompt_version=excluded.prompt_version,
          evidence_json=excluded.evidence_json,
          created_at=excluded.created_at`)
        .bind(
          relationId,
          job.documentId,
          relation.source,
          relation.target,
          relation.type,
          confidence,
          note,
          input.result.provider,
          input.result.providerVersion,
          input.result.promptVersion,
          JSON.stringify(evidence),
          now,
          input.jobId,
          input.runtimeId,
          now,
        );
    });
    const completionStatement = this.db.prepare(`UPDATE enrichment_jobs
      SET status = CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.hash = document_hash) THEN ? ELSE 'stale' END,
          result_json = CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.hash = document_hash) THEN ? ELSE NULL END,
          error_code = CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.hash = document_hash) THEN NULL ELSE 'document_stale' END,
          error_message = CASE WHEN EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND d.hash = document_hash) THEN NULL ELSE '문서 해시가 변경되어 보강 결과를 적용하지 않았습니다.' END,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
      .bind(
        nextStatus,
        nextStatus === "stale" ? null : JSON.stringify(input.result),
        now,
        now,
        input.jobId,
        input.runtimeId,
        now,
      );
    const outcomes = await this.db.batch([...relationStatements, completionStatement]);
    const outcome = outcomes.at(-1);
    if (Number(outcome?.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.runtimeId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async fail(input: FailInput) {
    await this.ready();
    const now = timestamp(input.now);
    const job = requireJob(await this.get(input.jobId));
    assertLease(job, input.runtimeId, now);
    const nextStatus: EnrichmentJobStatus =
      input.retryable && job.attemptCount < job.maxAttempts ? "queued" : "failed";
    assertTransition(job.status, nextStatus);
    const outcome = await this.db.prepare(`UPDATE enrichment_jobs
      SET status = ?, error_code = ?, error_message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running') AND lease_expires_at > ?`)
      .bind(nextStatus, input.errorCode, input.errorMessage.slice(0, 1_000), now, nextStatus === "failed" ? now : null, input.jobId, input.runtimeId, now)
      .run();
    if (Number(outcome.meta.changes ?? 0) !== 1) {
      return this.classifyLeaseFailure(input.jobId, input.runtimeId, now);
    }
    return requireJob(await this.get(input.jobId));
  }

  async cancel(jobId: string, nowValue?: string) {
    await this.ready();
    const now = timestamp(nowValue);
    const outcome = await this.db.prepare(`UPDATE enrichment_jobs
      SET status = 'cancelled', error_code = 'cancelled', error_message = '사용자가 보강 작업을 취소했습니다.', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
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
    if (job.status !== "failed" && job.status !== "warning") {
      throw new EnrichmentRepositoryError("invalid_input", "실패 또는 경고 작업만 다시 시도할 수 있습니다.");
    }
    if (job.manualRetryCount >= MAX_MANUAL_ENRICHMENT_RETRIES) {
      throw new EnrichmentRepositoryError("retry_exhausted", "수동 재시도 한도를 초과했습니다.");
    }
    assertTransition(job.status, "queued");
    const outcomes = await this.db.batch([
      this.db.prepare(`DELETE FROM relations
        WHERE document_id = ? AND origin = 'codex' AND provider = ?
          AND provider_version = ? AND prompt_version = ?`)
        .bind(job.documentId, job.provider, job.providerVersion, job.promptVersion),
      this.db.prepare(`UPDATE enrichment_jobs
        SET status = 'queued', result_json = NULL, attempt_count = 0,
            manual_retry_count = manual_retry_count + 1, last_manual_retry_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, error_code = NULL,
            error_message = NULL, started_at = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('failed', 'warning') AND manual_retry_count < ?`)
        .bind(now, now, jobId, MAX_MANUAL_ENRICHMENT_RETRIES),
    ]);
    if (Number(outcomes.at(-1)?.meta.changes ?? 0) !== 1) {
      throw new EnrichmentRepositoryError("lease_conflict", "재시도 상태가 동시에 변경되었습니다.");
    }
    return requireJob(await this.get(jobId));
  }

  async recordRuntimeStatus(input: RuntimeStatusInput) {
    await this.ready();
    const now = timestamp(input.now);
    await this.db.prepare(`INSERT INTO runtime_status
      (runtime_id, status, version, current_job_id, runtime_state, runtime_message, run_mode, max_jobs, max_runtime_ms,
       processed_jobs, succeeded_jobs, warning_jobs, failed_jobs, stop_reason, started_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(runtime_id) DO UPDATE SET status=excluded.status, version=excluded.version,
        current_job_id=excluded.current_job_id, runtime_state=excluded.runtime_state,
        runtime_message=excluded.runtime_message, run_mode=excluded.run_mode,
        max_jobs=excluded.max_jobs, max_runtime_ms=excluded.max_runtime_ms,
        processed_jobs=excluded.processed_jobs, succeeded_jobs=excluded.succeeded_jobs,
        warning_jobs=excluded.warning_jobs, failed_jobs=excluded.failed_jobs,
        stop_reason=excluded.stop_reason, last_seen_at=excluded.last_seen_at`)
      .bind(
        input.runtimeId,
        input.status,
        input.version,
        input.currentJobId ?? null,
        input.runtimeState ?? null,
        input.runtimeMessage?.slice(0, 500) ?? null,
        input.runMode ?? null,
        input.maxJobs ?? null,
        input.maxRuntimeMs ?? null,
        input.processedJobs ?? null,
        input.succeededJobs ?? null,
        input.warningJobs ?? null,
        input.failedJobs ?? null,
        input.stopReason ?? null,
        now,
        now,
      )
      .run();
    const row = await this.db.prepare("SELECT * FROM runtime_status WHERE runtime_id = ?")
      .bind(input.runtimeId).first<D1Row>();
    return asD1RuntimeStatus(row ?? {});
  }

  async listRuntimeStatuses() {
    await this.ready();
    const result = await this.db.prepare("SELECT * FROM runtime_status ORDER BY last_seen_at DESC")
      .all<D1Row>();
    return result.results.map(asD1RuntimeStatus);
  }

  async markDocumentStale(
    documentId: string,
    currentDocumentHash: string,
    nowValue?: string,
    includeCurrentHash = false,
  ) {
    await this.ready();
    const now = timestamp(nowValue);
    const outcome = await this.db.prepare(`UPDATE enrichment_jobs
      SET status = 'stale', error_code = 'document_stale', error_message = '문서 해시가 변경되어 작업을 무효화했습니다.', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?, completed_at = ?
      WHERE document_id = ? AND (document_hash <> ? OR ? = 1)
        AND status IN ('queued', 'leased', 'running', 'completed', 'warning')`)
      .bind(now, now, documentId, currentDocumentHash, includeCurrentHash ? 1 : 0).run();
    return Number(outcome.meta.changes ?? 0);
  }

  async deleteForDocument(documentId: string) {
    await this.ready();
    const outcome = await this.db.prepare("DELETE FROM enrichment_jobs WHERE document_id = ?")
      .bind(documentId).run();
    return Number(outcome.meta.changes ?? 0);
  }
}

const memoryKey = "__AI_ATLAS_ENRICHMENT_JOB_STORE__";
const testDatabaseKey = "__AI_ATLAS_TEST_D1__";

function defaultMemoryRepository() {
  const root = globalThis as typeof globalThis & {
    [memoryKey]?: MemoryEnrichmentJobRepository;
  };
  root[memoryKey] ??= new MemoryEnrichmentJobRepository();
  return root[memoryKey];
}

async function database() {
  if (process.env.ATLAS_MEMORY_STORAGE === "true") return null;
  if (process.env.ATLAS_TEST_MODE === "true") {
    const testDatabase = (globalThis as typeof globalThis & {
      [testDatabaseKey]?: D1Database;
    })[testDatabaseKey];
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

export const createMemoryEnrichmentJobRepository = () => new MemoryEnrichmentJobRepository();
export const createD1EnrichmentJobRepository = (db: D1Database) =>
  new D1EnrichmentJobRepository(db);

export async function getEnrichmentJobRepository(): Promise<EnrichmentJobRepository> {
  const db = await database();
  return db ? new D1EnrichmentJobRepository(db) : defaultMemoryRepository();
}
