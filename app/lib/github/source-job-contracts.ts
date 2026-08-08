import { sha256 } from "../markdown/normalize.js";
import { parseGitHubDiscoverySnapshot, type GitHubDiscoverySnapshot } from "./discovery-contracts.js";
import {
  GITHUB_PREVIEW_MAX_REPOSITORIES,
  parseGitHubPreviewSnapshot,
  type GitHubPreviewSnapshot,
} from "./repository-manifest.js";

export const GITHUB_SOURCE_JOB_KINDS = ["discovery", "preview", "apply"] as const;
export type GitHubSourceJobKind = (typeof GITHUB_SOURCE_JOB_KINDS)[number];
export const MAX_MANUAL_GITHUB_SOURCE_RETRIES = 2;
export const INTEGRATED_GITHUB_RUNTIME_VERSION = "atlas-integrated-github-runtime-1";

export const GITHUB_SYNC_TRIGGERS = ["manual", "schedule", "webhook"] as const;
export type GitHubSyncTrigger = (typeof GITHUB_SYNC_TRIGGERS)[number];

export const GITHUB_SOURCE_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type GitHubSourceJobStatus = (typeof GITHUB_SOURCE_JOB_STATUSES)[number];

export const GITHUB_SOURCE_ERROR_CODES = [
  "gh_missing",
  "gh_auth_required",
  "github_forbidden",
  "github_rate_limited",
  "runtime_unavailable",
  "lease_conflict",
  "lease_expired",
  "invalid_input",
  "invalid_result",
  "cancelled",
  "retry_exhausted",
  "unknown",
] as const;
export type GitHubSourceErrorCode = (typeof GITHUB_SOURCE_ERROR_CODES)[number];

export class GitHubSourceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubSourceContractError";
  }
}

export const GITHUB_CAPABILITY_STATUSES = [
  "online",
  "login_required",
  "forbidden",
  "rate_limited",
  "offline",
] as const;
export type GitHubCapabilityStatus = (typeof GITHUB_CAPABILITY_STATUSES)[number];

export type GitHubSourceJobInput = {
  jobId: string;
  idempotencyKey: string;
  kind: GitHubSourceJobKind;
  owner: "coreline-ai";
  runtimeVersion?: string;
  selectedRepositoryIds: string[];
  manifestDigest?: string;
  requestNonce?: string;
  syncTrigger?: GitHubSyncTrigger;
  syncRunId?: string;
  reusableDocuments?: GitHubReusableDocument[];
};

export type GitHubReusableDocument = {
  repositoryId: string;
  path: string;
  blobSha: string;
  size: number;
};

export type GitHubSourceJobSummary = {
  discoveredCount: number;
  selectedCount: number;
  changedCount: number;
  unchangedCount: number;
  deletedCount: number;
  failedCount: number;
};

export type GitHubApplyReceipt = {
  repositoryId: string;
  repositoryName: string;
  commitSha: string;
  manifestDigest: string;
  fileCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  deletedCount: number;
  nodeCount: number;
  edgeCount: number;
  appliedAt: string;
};

export type GitHubRuntimeCapabilityRecord = {
  runtimeId: string;
  capability: "github-source";
  status: GitHubCapabilityStatus;
  errorCode?: GitHubSourceErrorCode;
  accountLogin?: string;
  host?: string;
  rateLimitResetAt?: string;
  message?: string;
  checkedAt: string;
  lastSeenAt: string;
};

export type GitHubSourceJobResult = {
  jobId: string;
  idempotencyKey: string;
  kind: GitHubSourceJobKind;
  status: "completed";
  capability: Omit<GitHubRuntimeCapabilityRecord, "runtimeId" | "lastSeenAt">;
  summary: GitHubSourceJobSummary;
  discovery?: GitHubDiscoverySnapshot;
  preview?: GitHubPreviewSnapshot;
  apply?: GitHubApplyReceipt;
};

export type GitHubSourceJobRecord = {
  id: string;
  idempotencyKey: string;
  kind: GitHubSourceJobKind;
  owner: "coreline-ai";
  status: GitHubSourceJobStatus;
  input: GitHubSourceJobInput;
  result?: GitHubSourceJobResult;
  attemptCount: number;
  maxAttempts: number;
  manualRetryCount: number;
  lastManualRetryAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: GitHubSourceErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export const GITHUB_SOURCE_STATUS_TRANSITIONS: Readonly<
  Record<GitHubSourceJobStatus, readonly GitHubSourceJobStatus[]>
> = Object.freeze({
  queued: ["leased", "cancelled"],
  leased: ["leased", "running", "queued", "completed", "failed", "cancelled"],
  running: ["leased", "queued", "completed", "failed", "cancelled"],
  completed: [],
  failed: ["queued"],
  cancelled: [],
});

export const canTransitionGitHubSourceJob = (
  from: GitHubSourceJobStatus,
  to: GitHubSourceJobStatus,
) => GITHUB_SOURCE_STATUS_TRANSITIONS[from].includes(to);

const forbiddenCredentialNames = new Set([
  "authorization",
  "apikey",
  "credential",
  "credentials",
  "oauthtoken",
  "password",
  "pat",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "githubtoken",
  "privatekey",
]);
const repositoryIdPattern = /^[1-9][0-9]*$/;
const digestPattern = /^[0-9a-f]{64}$/i;
const accountPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const hostPattern = /^[a-zA-Z0-9.-]{1,253}$/;
const requestNoncePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const githubCredentialPattern = /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/g;
const bearerCredentialPattern = /\bauthorization\s*:\s*bearer\s+([a-zA-Z0-9._~+/=-]{3,})/ig;
const assignedCredentialPattern = /\b(?:oauth[_-]?token|access[_-]?token)\s*[:=]\s*(\S+)/ig;
const documentationCredentialPlaceholder = /^(?:<[^>]+>|\$\{[^}]+\}|local[-_]?dev[-_]?only|(?:example|sample|test|dummy|placeholder)(?:[-_]?(?:token|value|only))?|(?:your|insert|replace)(?:[-_](?:access[-_]?)?token(?:[-_]here)?)|token(?:[-_]here)?|(?:gh[pousr]_|github_pat_)x{20,}|x{3,}|\.{3,}|.+(?:\.{3}|…))$/i;

function normalizedCredentialCandidate(value: string) {
  return value.trim().replace(/^["'`]+|["'`,;]+$/g, "");
}

function isDocumentationCredentialPlaceholder(value: string) {
  return documentationCredentialPlaceholder.test(normalizedCredentialCandidate(value));
}

function containsCredentialValue(value: string) {
  for (const match of value.matchAll(githubCredentialPattern)) {
    if (!isDocumentationCredentialPlaceholder(match[0])) return true;
  }
  for (const match of value.matchAll(bearerCredentialPattern)) {
    if (!isDocumentationCredentialPlaceholder(match[1])) return true;
  }
  for (const match of value.matchAll(assignedCredentialPattern)) {
    if (!isDocumentationCredentialPlaceholder(match[1])) return true;
  }
  return false;
}

const objectValue = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

export function assertCredentialFreePayload(value: unknown, path = "payload"): void {
  if (typeof value === "string") {
    if (containsCredentialValue(value)) {
      throw new GitHubSourceContractError(`${path}: GitHub 자격 증명으로 보이는 값은 허용되지 않습니다.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialFreePayload(item, `${path}[${index}]`));
    return;
  }
  const object = objectValue(value);
  if (!object) return;
  for (const [key, item] of Object.entries(object)) {
    const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
    if (forbiddenCredentialNames.has(normalizedKey)) {
      throw new GitHubSourceContractError(`${path}.${key}: GitHub 자격 증명 필드는 허용되지 않습니다.`);
    }
    assertCredentialFreePayload(item, `${path}.${key}`);
  }
}

function exactKeys(object: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new GitHubSourceContractError(`허용되지 않은 필드입니다: ${unknown.join(", ")}`);
}

const cleanRepositoryIds = (value: unknown) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) {
    throw new GitHubSourceContractError("selectedRepositoryIds는 최대 500개의 배열이어야 합니다.");
  }
  const ids = value.map((item) => String(item));
  if (ids.some((id) => !repositoryIdPattern.test(id))) {
    throw new GitHubSourceContractError("selectedRepositoryIds에는 숫자 문자열만 사용할 수 있습니다.");
  }
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
};

export async function parseGitHubSourceJobRequest(value: unknown): Promise<GitHubSourceJobInput> {
  assertCredentialFreePayload(value);
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("GitHub source 작업 요청은 객체여야 합니다.");
  exactKeys(object, [
    "kind",
    "owner",
    "selectedRepositoryIds",
    "manifestDigest",
    "requestNonce",
    "syncTrigger",
    "syncRunId",
  ]);
  const kind = String(object.kind ?? "") as GitHubSourceJobKind;
  if (!GITHUB_SOURCE_JOB_KINDS.includes(kind)) throw new GitHubSourceContractError("지원하지 않는 GitHub source 작업입니다.");
  const owner = String(object.owner ?? "coreline-ai");
  if (owner !== "coreline-ai") throw new GitHubSourceContractError("GitHub owner는 coreline-ai만 허용됩니다.");
  const selectedRepositoryIds = cleanRepositoryIds(object.selectedRepositoryIds);
  const manifestDigest = object.manifestDigest === undefined
    ? undefined
    : String(object.manifestDigest).toLowerCase();
  if (manifestDigest && !digestPattern.test(manifestDigest)) {
    throw new GitHubSourceContractError("manifestDigest는 SHA-256 digest여야 합니다.");
  }
  if (kind === "apply" && (selectedRepositoryIds.length !== 1 || !manifestDigest)) {
    throw new GitHubSourceContractError("P4-A apply 작업에는 저장소 1개와 manifestDigest가 필요합니다.");
  }
  if (
    kind === "preview"
    && (!selectedRepositoryIds.length || selectedRepositoryIds.length > GITHUB_PREVIEW_MAX_REPOSITORIES)
  ) {
    throw new GitHubSourceContractError(`preview 작업에는 1~${GITHUB_PREVIEW_MAX_REPOSITORIES}개의 선택 저장소가 필요합니다.`);
  }
  const requestNonce = object.requestNonce === undefined ? undefined : String(object.requestNonce);
  if (requestNonce && !requestNoncePattern.test(requestNonce)) {
    throw new GitHubSourceContractError("requestNonce 형식이 잘못되었습니다.");
  }
  const syncTrigger = object.syncTrigger === undefined
    ? undefined
    : String(object.syncTrigger) as GitHubSyncTrigger;
  if (syncTrigger && !GITHUB_SYNC_TRIGGERS.includes(syncTrigger)) {
    throw new GitHubSourceContractError("지원하지 않는 GitHub 증분 동기화 trigger입니다.");
  }
  const syncRunId = object.syncRunId === undefined ? undefined : String(object.syncRunId);
  if (syncRunId && !requestNoncePattern.test(syncRunId)) {
    throw new GitHubSourceContractError("syncRunId 형식이 잘못되었습니다.");
  }
  if ((syncTrigger === undefined) !== (syncRunId === undefined)) {
    throw new GitHubSourceContractError("syncTrigger와 syncRunId는 함께 제공해야 합니다.");
  }
  const canonical = JSON.stringify({
    kind,
    owner,
    runtimeVersion: INTEGRATED_GITHUB_RUNTIME_VERSION,
    selectedRepositoryIds,
    manifestDigest,
    requestNonce,
    syncTrigger,
    syncRunId,
  });
  const idempotencyKey = await sha256(canonical);
  return {
    jobId: `github-source:${kind}:${idempotencyKey.slice(0, 40)}`,
    idempotencyKey,
    kind,
    owner: "coreline-ai",
    runtimeVersion: INTEGRATED_GITHUB_RUNTIME_VERSION,
    selectedRepositoryIds,
    manifestDigest,
    requestNonce,
    syncTrigger,
    syncRunId,
  };
}

const safeCount = (value: unknown) => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new GitHubSourceContractError("작업 집계는 0 이상의 정수여야 합니다.");
  return count;
};

export function parseGitHubApplyReceipt(value: unknown): GitHubApplyReceipt {
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("GitHub apply receipt는 객체여야 합니다.");
  exactKeys(object, [
    "repositoryId", "repositoryName", "commitSha", "manifestDigest", "fileCount",
    "createdCount", "updatedCount", "unchangedCount", "deletedCount", "nodeCount",
    "edgeCount", "appliedAt",
  ]);
  const repositoryId = String(object.repositoryId ?? "");
  const repositoryName = String(object.repositoryName ?? "");
  const commitSha = String(object.commitSha ?? "").toLowerCase();
  const manifestDigest = String(object.manifestDigest ?? "").toLowerCase();
  if (!repositoryIdPattern.test(repositoryId) || !/^[a-zA-Z0-9._-]{1,100}$/.test(repositoryName)) {
    throw new GitHubSourceContractError("GitHub apply receipt 저장소 identity가 잘못되었습니다.");
  }
  if (!/^[0-9a-f]{40,64}$/.test(commitSha) || !digestPattern.test(manifestDigest)) {
    throw new GitHubSourceContractError("GitHub apply receipt digest가 잘못되었습니다.");
  }
  const receipt = {
    repositoryId,
    repositoryName,
    commitSha,
    manifestDigest,
    fileCount: safeCount(object.fileCount),
    createdCount: safeCount(object.createdCount),
    updatedCount: safeCount(object.updatedCount),
    unchangedCount: safeCount(object.unchangedCount),
    deletedCount: safeCount(object.deletedCount),
    nodeCount: safeCount(object.nodeCount),
    edgeCount: safeCount(object.edgeCount),
    appliedAt: String(object.appliedAt ?? ""),
  };
  if (!Number.isFinite(Date.parse(receipt.appliedAt))) {
    throw new GitHubSourceContractError("GitHub apply receipt appliedAt 형식이 잘못되었습니다.");
  }
  if (receipt.fileCount !== receipt.createdCount + receipt.updatedCount + receipt.unchangedCount) {
    throw new GitHubSourceContractError("GitHub apply receipt 파일 집계가 일치하지 않습니다.");
  }
  return receipt;
}

export function validateGitHubSourceJobResult(
  value: unknown,
  job: GitHubSourceJobRecord,
): GitHubSourceJobResult {
  assertCredentialFreePayload(value);
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("GitHub source 작업 결과는 객체여야 합니다.");
  exactKeys(object, ["jobId", "idempotencyKey", "kind", "status", "capability", "summary", "discovery", "preview", "apply"]);
  if (
    object.jobId !== job.id ||
    object.idempotencyKey !== job.idempotencyKey ||
    object.kind !== job.kind ||
    object.status !== "completed"
  ) {
    throw new GitHubSourceContractError("GitHub source 작업 결과 식별자가 요청과 일치하지 않습니다.");
  }
  const capability = parseGitHubCapabilityReport(object.capability);
  const summary = objectValue(object.summary);
  if (!summary) throw new GitHubSourceContractError("GitHub source 작업 결과 summary가 필요합니다.");
  exactKeys(summary, [
    "discoveredCount",
    "selectedCount",
    "changedCount",
    "unchangedCount",
    "deletedCount",
    "failedCount",
  ]);
  const discovery = object.discovery === undefined ? undefined : parseGitHubDiscoverySnapshot(object.discovery);
  if (discovery && job.kind !== "discovery") {
    throw new GitHubSourceContractError("discovery snapshot은 discovery 작업 결과에만 허용됩니다.");
  }
  const preview = object.preview === undefined ? undefined : parseGitHubPreviewSnapshot(object.preview);
  if (preview && job.kind !== "preview") {
    throw new GitHubSourceContractError("preview snapshot은 preview 작업 결과에만 허용됩니다.");
  }
  if (preview && JSON.stringify(preview.selectedRepositoryIds) !== JSON.stringify(job.input.selectedRepositoryIds)) {
    throw new GitHubSourceContractError("preview 선택 저장소가 작업 입력과 일치하지 않습니다.");
  }
  const apply = object.apply === undefined ? undefined : parseGitHubApplyReceipt(object.apply);
  if (apply && job.kind !== "apply") {
    throw new GitHubSourceContractError("apply receipt는 apply 작업 결과에만 허용됩니다.");
  }
  if (
    apply
    && (apply.repositoryId !== job.input.selectedRepositoryIds[0]
      || apply.manifestDigest !== job.input.manifestDigest)
  ) {
    throw new GitHubSourceContractError("apply receipt가 작업 입력과 일치하지 않습니다.");
  }
  const parsedSummary = {
    discoveredCount: safeCount(summary.discoveredCount),
    selectedCount: safeCount(summary.selectedCount),
    changedCount: safeCount(summary.changedCount),
    unchangedCount: safeCount(summary.unchangedCount),
    deletedCount: safeCount(summary.deletedCount),
    failedCount: safeCount(summary.failedCount),
  };
  if (
    discovery
    && (parsedSummary.discoveredCount !== discovery.totals.total
      || parsedSummary.selectedCount !== discovery.totals.selected)
  ) {
    throw new GitHubSourceContractError("GitHub source summary와 discovery 집계가 일치하지 않습니다.");
  }
  if (
    apply
    && (parsedSummary.discoveredCount !== 1
      || parsedSummary.selectedCount !== 1
      || parsedSummary.changedCount !== apply.createdCount + apply.updatedCount
      || parsedSummary.unchangedCount !== apply.unchangedCount
      || parsedSummary.deletedCount !== apply.deletedCount
      || parsedSummary.failedCount !== 0)
  ) {
    throw new GitHubSourceContractError("GitHub source summary와 apply receipt 집계가 일치하지 않습니다.");
  }
  return {
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    kind: job.kind,
    status: "completed",
    capability,
    summary: parsedSummary,
    discovery,
    preview,
    apply,
  };
}

export function normalizeGitHubCapability(input: {
  runtimeOnline: boolean;
  ghInstalled: boolean;
  authenticated: boolean;
  authorized: boolean;
  rateLimited?: boolean;
}): { status: GitHubCapabilityStatus; errorCode?: GitHubSourceErrorCode } {
  if (!input.runtimeOnline) return { status: "offline", errorCode: "runtime_unavailable" };
  if (!input.ghInstalled) return { status: "offline", errorCode: "gh_missing" };
  if (!input.authenticated) return { status: "login_required", errorCode: "gh_auth_required" };
  if (!input.authorized) return { status: "forbidden", errorCode: "github_forbidden" };
  if (input.rateLimited) return { status: "rate_limited", errorCode: "github_rate_limited" };
  return { status: "online" };
}

export function parseGitHubCapabilityReport(
  value: unknown,
): Omit<GitHubRuntimeCapabilityRecord, "runtimeId" | "lastSeenAt"> {
  assertCredentialFreePayload(value);
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("GitHub capability 보고는 객체여야 합니다.");
  exactKeys(object, [
    "capability",
    "status",
    "errorCode",
    "accountLogin",
    "host",
    "rateLimitResetAt",
    "message",
    "checkedAt",
  ]);
  if (object.capability !== "github-source") {
    throw new GitHubSourceContractError("github-source capability 식별자가 필요합니다.");
  }
  const status = String(object.status ?? "") as GitHubCapabilityStatus;
  if (!GITHUB_CAPABILITY_STATUSES.includes(status)) throw new GitHubSourceContractError("지원하지 않는 GitHub capability 상태입니다.");
  const errorCode = object.errorCode === undefined
    ? undefined
    : String(object.errorCode) as GitHubSourceErrorCode;
  if (errorCode && !GITHUB_SOURCE_ERROR_CODES.includes(errorCode)) {
    throw new GitHubSourceContractError("지원하지 않는 GitHub capability 오류 코드입니다.");
  }
  const allowedErrors: Record<GitHubCapabilityStatus, readonly GitHubSourceErrorCode[]> = {
    online: [],
    login_required: ["gh_auth_required"],
    forbidden: ["github_forbidden"],
    rate_limited: ["github_rate_limited"],
    offline: ["runtime_unavailable", "gh_missing"],
  };
  if (
    (status === "online" && errorCode !== undefined) ||
    (status !== "online" && (!errorCode || !allowedErrors[status].includes(errorCode)))
  ) {
    throw new GitHubSourceContractError("GitHub capability 상태와 오류 코드가 일치하지 않습니다.");
  }
  const accountLogin = object.accountLogin === undefined ? undefined : String(object.accountLogin);
  if (accountLogin && !accountPattern.test(accountLogin)) throw new GitHubSourceContractError("GitHub accountLogin 형식이 잘못되었습니다.");
  const host = object.host === undefined ? undefined : String(object.host).toLowerCase();
  if (host && !hostPattern.test(host)) throw new GitHubSourceContractError("GitHub host 형식이 잘못되었습니다.");
  const checkedAt = String(object.checkedAt ?? "");
  if (!Number.isFinite(Date.parse(checkedAt))) throw new GitHubSourceContractError("GitHub capability checkedAt이 필요합니다.");
  const rateLimitResetAt = object.rateLimitResetAt === undefined
    ? undefined
    : String(object.rateLimitResetAt);
  if (rateLimitResetAt && !Number.isFinite(Date.parse(rateLimitResetAt))) {
    throw new GitHubSourceContractError("GitHub rateLimitResetAt 형식이 잘못되었습니다.");
  }
  return {
    capability: "github-source",
    status,
    errorCode,
    accountLogin,
    host,
    rateLimitResetAt,
    message: object.message === undefined ? undefined : String(object.message).slice(0, 300),
    checkedAt,
  };
}
