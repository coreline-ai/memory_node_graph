import type { GitHubRepositoryStorageSummary } from "../graph/model";
import type {
  GitHubSourceErrorCode,
  GitHubSourceJobRecord,
} from "./source-job-contracts.js";
import { MAX_MANUAL_GITHUB_SOURCE_RETRIES } from "./source-job-contracts.js";

export type GitHubRepositorySyncStatus =
  | "not_synced"
  | "syncing"
  | "synced"
  | "failed"
  | "cancelled";

export type GitHubRepositorySyncSummary = {
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  status: GitHubRepositorySyncStatus;
  documentCount: number;
  nodeCount: number;
  edgeCount: number;
  commitSha?: string;
  lastSyncedAt?: string;
  lastAttemptAt?: string;
  errorCode?: GitHubSourceErrorCode;
  errorMessage?: string;
  retry?: {
    jobId: string;
    manualRetryCount: number;
    maxManualRetries: number;
    available: boolean;
  };
};

const statusPriority: Record<GitHubRepositorySyncStatus, number> = {
  failed: 0,
  syncing: 1,
  synced: 2,
  cancelled: 3,
  not_synced: 4,
};

const emptySummary = (
  repositoryId: string,
  repositoryName = repositoryId,
): GitHubRepositorySyncSummary => ({
  repositoryId,
  repositoryOwner: "coreline-ai",
  repositoryName,
  status: "not_synced",
  documentCount: 0,
  nodeCount: 0,
  edgeCount: 0,
});

export function projectGitHubRepositorySyncSummaries(
  jobs: readonly GitHubSourceJobRecord[],
  storedRepositories: readonly GitHubRepositoryStorageSummary[],
): GitHubRepositorySyncSummary[] {
  const summaries = new Map<string, GitHubRepositorySyncSummary>();
  const orderedJobs = [...jobs].sort((left, right) =>
    left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id));

  const discoveries = orderedJobs.filter((job) => job.result?.discovery);
  const latestDiscovery = discoveries.at(-1)?.result?.discovery;
  for (const repository of latestDiscovery?.repositories ?? []) {
    summaries.set(repository.repositoryId, emptySummary(repository.repositoryId, repository.name));
  }

  for (const job of orderedJobs) {
    for (const repository of job.result?.preview?.repositories ?? []) {
      const current = summaries.get(repository.repositoryId)
        ?? emptySummary(repository.repositoryId, repository.repositoryName);
      current.repositoryName = repository.repositoryName;
      summaries.set(repository.repositoryId, current);
    }
    const receipt = job.result?.apply;
    if (receipt) {
      const current = summaries.get(receipt.repositoryId)
        ?? emptySummary(receipt.repositoryId, receipt.repositoryName);
      current.repositoryName = receipt.repositoryName;
      summaries.set(receipt.repositoryId, current);
    }
  }

  for (const stored of storedRepositories) {
    const current = summaries.get(stored.repositoryId)
      ?? emptySummary(stored.repositoryId, stored.repositoryName);
    summaries.set(stored.repositoryId, {
      ...current,
      repositoryOwner: stored.repositoryOwner,
      repositoryName: stored.repositoryName,
      status: "synced",
      documentCount: stored.documentCount,
      nodeCount: stored.nodeCount,
      edgeCount: stored.edgeCount,
      commitSha: stored.commitSha,
      lastSyncedAt: stored.lastSyncedAt,
      errorCode: undefined,
      errorMessage: undefined,
    });
  }

  for (const job of orderedJobs.filter((item) => item.kind === "apply")) {
    const repositoryId = job.input.selectedRepositoryIds[0];
    if (!repositoryId) continue;
    const current = summaries.get(repositoryId) ?? emptySummary(repositoryId);
    if (current.lastSyncedAt && job.updatedAt < current.lastSyncedAt) continue;
    const next: GitHubRepositorySyncSummary = {
      ...current,
      lastAttemptAt: job.updatedAt,
      errorCode: undefined,
      errorMessage: undefined,
    };
    delete next.retry;
    if (["queued", "leased", "running"].includes(job.status)) {
      next.status = "syncing";
    } else if (job.status === "failed") {
      next.status = "failed";
      next.errorCode = job.errorCode;
      next.errorMessage = job.errorMessage;
      next.retry = {
        jobId: job.id,
        manualRetryCount: job.manualRetryCount,
        maxManualRetries: MAX_MANUAL_GITHUB_SOURCE_RETRIES,
        available: job.manualRetryCount < MAX_MANUAL_GITHUB_SOURCE_RETRIES,
      };
    } else if (job.status === "cancelled") {
      next.status = "cancelled";
      next.errorCode = job.errorCode;
      next.errorMessage = job.errorMessage;
    } else if (job.status === "completed" && job.result?.apply) {
      const receipt = job.result.apply;
      next.status = "synced";
      next.repositoryName = receipt.repositoryName;
      next.documentCount = receipt.fileCount;
      next.nodeCount = receipt.nodeCount;
      next.edgeCount = receipt.edgeCount;
      next.commitSha = receipt.commitSha;
      next.lastSyncedAt = receipt.appliedAt;
    }
    summaries.set(repositoryId, next);
  }

  return [...summaries.values()].sort((left, right) =>
    statusPriority[left.status] - statusPriority[right.status]
    || (right.lastAttemptAt ?? right.lastSyncedAt ?? "")
      .localeCompare(left.lastAttemptAt ?? left.lastSyncedAt ?? "")
    || left.repositoryName.localeCompare(right.repositoryName)
    || left.repositoryId.localeCompare(right.repositoryId));
}
