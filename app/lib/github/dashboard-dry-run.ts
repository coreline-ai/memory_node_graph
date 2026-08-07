import type {
  CurrentGitHubDocumentState,
  GitHubDryRunSummary,
  GitHubRepositoryDryRun,
} from "./repository-manifest.js";
import { buildGitHubRepositoryDryRun } from "./repository-manifest.js";
import type { GitHubSourceJobRecord } from "./source-job-contracts.js";

export type GitHubDashboardRepositoryDryRun = GitHubRepositoryDryRun & {
  repositoryName: string;
};

export type GitHubDashboardDryRun = {
  previewJobId: string;
  status: "ready" | "blocked";
  manifestDigest: string;
  generatedAt: string;
  repositories: GitHubDashboardRepositoryDryRun[];
  summary: GitHubDryRunSummary;
};

const emptySummary = (): GitHubDryRunSummary => ({
  createCount: 0,
  updateCount: 0,
  deleteCount: 0,
  unchangedCount: 0,
});

export function projectGitHubDashboardDryRun(
  jobs: readonly GitHubSourceJobRecord[],
  currentDocuments: readonly CurrentGitHubDocumentState[],
): GitHubDashboardDryRun | null {
  const previewJob = [...jobs]
    .filter((job) => job.kind === "preview" && job.status === "completed" && job.result?.preview)
    .sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
  const preview = previewJob?.result?.preview;
  if (!previewJob || !preview) return null;

  const repositories = preview.repositories.map((manifest) => ({
    ...buildGitHubRepositoryDryRun(manifest, currentDocuments),
    repositoryName: manifest.repositoryName,
  }));
  const summary = repositories.reduce((total, repository) => ({
    createCount: total.createCount + repository.summary.createCount,
    updateCount: total.updateCount + repository.summary.updateCount,
    deleteCount: total.deleteCount + repository.summary.deleteCount,
    unchangedCount: total.unchangedCount + repository.summary.unchangedCount,
  }), emptySummary());

  return {
    previewJobId: previewJob.id,
    status: repositories.some((repository) => repository.status === "blocked")
      ? "blocked"
      : "ready",
    manifestDigest: preview.manifestDigest,
    generatedAt: preview.generatedAt,
    repositories,
    summary,
  };
}
