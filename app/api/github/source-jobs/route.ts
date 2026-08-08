import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../lib/auth/write-access";
import { parseGitHubSourceJobRequest } from "../../../lib/github/source-job-contracts";
import { attachGitHubApplyReusePlan } from "../../../lib/github/apply-plan";
import { githubSourceApiError } from "../../../lib/http/github-source-api";
import { readLimitedJson } from "../../../lib/http/enrichment-api";
import { getGitHubSourceJobRepository } from "../../../lib/storage/github-source-job-repository";
import {
  getGitHubRepositoryStorageSummaries,
  listGitHubRepositoryDocuments,
} from "../../../lib/storage/graph-repository";
import { projectGitHubRepositorySyncSummaries } from "../../../lib/github/dashboard-projection";
import { projectGitHubDashboardDryRun } from "../../../lib/github/dashboard-dry-run";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const repository = await getGitHubSourceJobRepository();
    const [jobs, capabilities, storedRepositories] = await Promise.all([
      repository.list(),
      repository.listRuntimeCapabilities(),
      getGitHubRepositoryStorageSummaries(),
    ]);
    const latestPreview = [...jobs]
      .filter((job) => job.kind === "preview" && job.status === "completed" && job.result?.preview)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0];
    const currentDocuments = latestPreview?.result?.preview
      ? (await Promise.all(latestPreview.result.preview.selectedRepositoryIds.map(async (repositoryId) =>
          (await listGitHubRepositoryDocuments(repositoryId)).map((document) => ({
            repositoryId,
            sourceKey: document.sourceKey as `github:${string}:${string}`,
            relativePath: document.sourceDescriptor.relativePath,
            blobSha: document.sourceDescriptor.blobSha,
          }))
        ))).flat()
      : [];
    return NextResponse.json(
      {
        jobs,
        capabilities,
        repositorySync: projectGitHubRepositorySyncSummaries(jobs, storedRepositories),
        repositoryDryRun: projectGitHubDashboardDryRun(jobs, currentDocuments),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return githubSourceApiError(error);
  }
}

export async function POST(request: Request) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const requestedInput = await parseGitHubSourceJobRequest(await readLimitedJson(request, 32_000));
    const repository = await getGitHubSourceJobRepository();
    const input = requestedInput.kind === "apply"
      ? await attachGitHubApplyReusePlan(requestedInput, await repository.list())
      : requestedInput;
    const result = await repository.enqueue(input);
    return NextResponse.json(result, {
      status: result.created ? 201 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return githubSourceApiError(error);
  }
}
