import type { GitHubRepositoryStorageSummary } from "../graph/model";
import {
  buildGitHubRepositoryDryRun,
  type CurrentGitHubDocumentState,
  type GitHubRepositoryDryRun,
} from "./repository-manifest.js";
import {
  assertCredentialFreePayload,
  GITHUB_SYNC_TRIGGERS,
  GitHubSourceContractError,
  MAX_MANUAL_GITHUB_SOURCE_RETRIES,
  type GitHubApplyReceipt,
  type GitHubSourceErrorCode,
  type GitHubSourceJobRecord,
  type GitHubSyncTrigger,
} from "./source-job-contracts.js";

export const GITHUB_INCREMENTAL_ACTIONS = ["preview", "apply"] as const;
export type GitHubIncrementalAction = (typeof GITHUB_INCREMENTAL_ACTIONS)[number];

export type GitHubIncrementalSyncRequest = {
  action: GitHubIncrementalAction;
  trigger: GitHubSyncTrigger;
  repositoryIds: string[];
  runId: string;
  approvedPreviewJobIds: string[];
};

export const GITHUB_INCREMENTAL_REPOSITORY_STATUSES = [
  "awaiting_preview",
  "preview_queued",
  "previewing",
  "changed",
  "unchanged",
  "blocked",
  "apply_queued",
  "applying",
  "applied",
  "failed",
  "cancelled",
] as const;
export type GitHubIncrementalRepositoryStatus =
  (typeof GITHUB_INCREMENTAL_REPOSITORY_STATUSES)[number];

export type GitHubIncrementalRepositoryResult = {
  repositoryId: string;
  repositoryName: string;
  status: GitHubIncrementalRepositoryStatus;
  previewJobId?: string;
  applyJobId?: string;
  commitChanged?: boolean;
  manifestChanged?: boolean;
  dryRun?: GitHubRepositoryDryRun;
  lastSuccessful?: {
    commitSha?: string;
    manifestDigest?: string;
    syncedAt: string;
  };
  preview?: {
    commitSha: string;
    manifestDigest: string;
    generatedAt: string;
  };
  applyReceipt?: GitHubApplyReceipt;
  errorCode?: GitHubSourceErrorCode;
  message?: string;
  retry?: {
    jobId: string;
    manualRetryCount: number;
    maxManualRetries: number;
    available: boolean;
  };
};

export type GitHubIncrementalRunReport = {
  runId: string;
  trigger: GitHubSyncTrigger;
  repositories: GitHubIncrementalRepositoryResult[];
  totals: Record<GitHubIncrementalRepositoryStatus, number> & {
    repositories: number;
  };
};

const objectValue = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const repositoryIdPattern = /^[1-9][0-9]{0,19}$/;
const runIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,49}$/;
const sourceJobIdPattern = /^github-source:preview:[0-9a-f]{40}$/;

function exactKeys(object: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new GitHubSourceContractError(`허용되지 않은 필드입니다: ${unknown.join(", ")}`);
  }
}

function parseRepositoryIds(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) {
    throw new GitHubSourceContractError("repositoryIds는 1~500개의 배열이어야 합니다.");
  }
  const repositoryIds = value.map(String);
  if (repositoryIds.some((repositoryId) => !repositoryIdPattern.test(repositoryId))) {
    throw new GitHubSourceContractError("repositoryIds에는 숫자 문자열만 사용할 수 있습니다.");
  }
  return [...new Set(repositoryIds)].sort((left, right) => left.localeCompare(right));
}

export function parseGitHubIncrementalSyncRequest(value: unknown): GitHubIncrementalSyncRequest {
  assertCredentialFreePayload(value);
  const object = objectValue(value);
  if (!object) throw new GitHubSourceContractError("GitHub 증분 동기화 요청은 객체여야 합니다.");
  exactKeys(object, ["action", "trigger", "repositoryIds", "runId", "approvedPreviewJobIds"]);
  const action = String(object.action ?? "") as GitHubIncrementalAction;
  if (!GITHUB_INCREMENTAL_ACTIONS.includes(action)) {
    throw new GitHubSourceContractError("지원하지 않는 GitHub 증분 동기화 action입니다.");
  }
  const trigger = String(object.trigger ?? "manual") as GitHubSyncTrigger;
  if (!GITHUB_SYNC_TRIGGERS.includes(trigger)) {
    throw new GitHubSourceContractError("지원하지 않는 GitHub 증분 동기화 trigger입니다.");
  }
  const repositoryIds = parseRepositoryIds(object.repositoryIds);
  const runId = String(object.runId ?? "");
  if (!runIdPattern.test(runId)) {
    throw new GitHubSourceContractError("runId는 50자 이하의 안전한 식별자여야 합니다.");
  }
  const approvedPreviewJobIds = object.approvedPreviewJobIds === undefined
    ? []
    : Array.isArray(object.approvedPreviewJobIds)
      ? [...new Set(object.approvedPreviewJobIds.map(String))]
      : [];
  if (
    (object.approvedPreviewJobIds !== undefined && !Array.isArray(object.approvedPreviewJobIds))
    || approvedPreviewJobIds.length > 500
    || approvedPreviewJobIds.some((jobId) => !sourceJobIdPattern.test(jobId))
  ) {
    throw new GitHubSourceContractError("approvedPreviewJobIds 형식이 잘못되었습니다.");
  }
  if (action === "preview" && approvedPreviewJobIds.length) {
    throw new GitHubSourceContractError("preview action에는 승인 작업 ID를 사용할 수 없습니다.");
  }
  if (action === "apply") {
    if (trigger !== "manual") {
      throw new GitHubSourceContractError("예약·Webhook은 preview만 실행할 수 있으며 Apply는 수동 승인이 필요합니다.");
    }
    if (approvedPreviewJobIds.length !== repositoryIds.length) {
      throw new GitHubSourceContractError("Apply에는 저장소별 승인된 Preview 작업 ID가 하나씩 필요합니다.");
    }
  }
  return { action, trigger, repositoryIds, runId, approvedPreviewJobIds };
}

const latestJob = (
  jobs: readonly GitHubSourceJobRecord[],
  repositoryId: string,
  kind: "preview" | "apply",
) => jobs.filter((job) =>
  job.kind === kind
  && job.input.selectedRepositoryIds.length === 1
  && job.input.selectedRepositoryIds[0] === repositoryId)
  .sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];

const failedResult = (
  repositoryId: string,
  repositoryName: string,
  job: GitHubSourceJobRecord,
): GitHubIncrementalRepositoryResult => ({
  repositoryId,
  repositoryName,
  status: job.status === "cancelled" ? "cancelled" : "failed",
  ...(job.kind === "preview" ? { previewJobId: job.id } : { applyJobId: job.id }),
  errorCode: job.errorCode,
  message: job.errorMessage,
  ...(job.status === "failed" ? {
    retry: {
      jobId: job.id,
      manualRetryCount: job.manualRetryCount,
      maxManualRetries: MAX_MANUAL_GITHUB_SOURCE_RETRIES,
      available: job.manualRetryCount < MAX_MANUAL_GITHUB_SOURCE_RETRIES,
    },
  } : {}),
});

function emptyTotals(): GitHubIncrementalRunReport["totals"] {
  return {
    repositories: 0,
    awaiting_preview: 0,
    preview_queued: 0,
    previewing: 0,
    changed: 0,
    unchanged: 0,
    blocked: 0,
    apply_queued: 0,
    applying: 0,
    applied: 0,
    failed: 0,
    cancelled: 0,
  };
}

export function projectGitHubIncrementalRun(input: {
  runId: string;
  trigger: GitHubSyncTrigger;
  repositoryIds: readonly string[];
  jobs: readonly GitHubSourceJobRecord[];
  storedRepositories: readonly GitHubRepositoryStorageSummary[];
  currentDocuments: readonly CurrentGitHubDocumentState[];
}): GitHubIncrementalRunReport {
  const runJobs = input.jobs.filter((job) => job.input.syncRunId === input.runId);
  const storedById = new Map(input.storedRepositories.map((stored) => [stored.repositoryId, stored]));
  const repositories = [...new Set(input.repositoryIds.map(String))]
    .sort((left, right) => left.localeCompare(right))
    .map((repositoryId): GitHubIncrementalRepositoryResult => {
      const stored = storedById.get(repositoryId);
      const base = {
        repositoryId,
        repositoryName: stored?.repositoryName ?? repositoryId,
        ...(stored ? {
          lastSuccessful: {
            commitSha: stored.commitSha,
            manifestDigest: stored.manifestDigest,
            syncedAt: stored.lastSyncedAt,
          },
        } : {}),
      };
      const apply = latestJob(runJobs, repositoryId, "apply");
      if (apply) {
        if (apply.status === "failed" || apply.status === "cancelled") {
          return { ...base, ...failedResult(repositoryId, base.repositoryName, apply) };
        }
        if (apply.status === "completed" && apply.result?.apply) {
          return {
            ...base,
            repositoryName: apply.result.apply.repositoryName,
            status: "applied",
            applyJobId: apply.id,
            applyReceipt: apply.result.apply,
          };
        }
        return {
          ...base,
          status: apply.status === "queued" ? "apply_queued" : "applying",
          applyJobId: apply.id,
        };
      }

      const previewJob = latestJob(runJobs, repositoryId, "preview");
      if (!previewJob) return { ...base, status: "awaiting_preview" };
      if (previewJob.status === "failed" || previewJob.status === "cancelled") {
        return { ...base, ...failedResult(repositoryId, base.repositoryName, previewJob) };
      }
      if (previewJob.status !== "completed") {
        return {
          ...base,
          status: previewJob.status === "queued" ? "preview_queued" : "previewing",
          previewJobId: previewJob.id,
        };
      }
      const preview = previewJob.result?.preview;
      const manifest = preview?.repositories.find((item) => item.repositoryId === repositoryId);
      if (!preview || !manifest) {
        return {
          ...base,
          status: "failed",
          previewJobId: previewJob.id,
          errorCode: "invalid_result",
          message: "완료된 Preview에 저장소 manifest가 없습니다.",
        };
      }
      const repositoryName = manifest.repositoryName;
      if (manifest.status === "blocked") {
        return {
          ...base,
          repositoryName,
          status: "blocked",
          previewJobId: previewJob.id,
          commitChanged: stored?.commitSha !== manifest.commitSha,
          manifestChanged: true,
          message: manifest.blockedReason,
        };
      }
      const dryRun = buildGitHubRepositoryDryRun(manifest, input.currentDocuments);
      const commitChanged = !stored || stored.commitSha !== manifest.commitSha;
      const manifestChanged = !stored || stored.manifestDigest !== preview.manifestDigest;
      const graphInputsChanged = dryRun.summary.createCount > 0
        || dryRun.summary.updateCount > 0
        || dryRun.summary.deleteCount > 0;
      return {
        ...base,
        repositoryName,
        status: commitChanged || manifestChanged || graphInputsChanged ? "changed" : "unchanged",
        previewJobId: previewJob.id,
        commitChanged,
        manifestChanged,
        dryRun,
        preview: {
          commitSha: manifest.commitSha,
          manifestDigest: preview.manifestDigest,
          generatedAt: preview.generatedAt,
        },
      };
    });
  const totals = repositories.reduce((result, repository) => {
    result.repositories += 1;
    result[repository.status] += 1;
    return result;
  }, emptyTotals());
  return { runId: input.runId, trigger: input.trigger, repositories, totals };
}
