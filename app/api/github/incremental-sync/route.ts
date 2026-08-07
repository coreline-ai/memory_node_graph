import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../lib/auth/write-access";
import { attachGitHubApplyReusePlan } from "../../../lib/github/apply-plan";
import {
  parseGitHubIncrementalSyncRequest,
  projectGitHubIncrementalRun,
  type GitHubIncrementalRunReport,
} from "../../../lib/github/incremental-sync";
import {
  GitHubSourceContractError,
  parseGitHubSourceJobRequest,
  type GitHubSourceErrorCode,
  type GitHubSourceJobRecord,
  type GitHubSyncTrigger,
} from "../../../lib/github/source-job-contracts";
import { githubSourceApiError } from "../../../lib/http/github-source-api";
import { readLimitedJson } from "../../../lib/http/enrichment-api";
import {
  getGitHubSourceJobRepository,
  GitHubSourceRepositoryError,
} from "../../../lib/storage/github-source-job-repository";
import {
  getGitHubRepositoryStorageSummaries,
  listGitHubRepositoryDocuments,
} from "../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

type OperationReceipt = {
  repositoryId: string;
  status: "created" | "reused" | "unchanged" | "blocked" | "active_elsewhere" | "rejected";
  jobId?: string;
  errorCode?: GitHubSourceErrorCode;
  message?: string;
};

const runIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,49}$/;

function isolatedError(repositoryId: string, error: unknown): OperationReceipt {
  if (error instanceof GitHubSourceRepositoryError) {
    return {
      repositoryId,
      status: "rejected",
      errorCode: error.code,
      message: error.message,
    };
  }
  if (error instanceof GitHubSourceContractError) {
    return {
      repositoryId,
      status: "rejected",
      errorCode: "invalid_input",
      message: error.message,
    };
  }
  return {
    repositoryId,
    status: "rejected",
    errorCode: "unknown",
    message: error instanceof Error ? error.message.slice(0, 300) : "저장소 작업을 등록하지 못했습니다.",
  };
}

async function currentDocuments(repositoryIds: readonly string[]) {
  return (await Promise.all(repositoryIds.map(async (repositoryId) =>
    (await listGitHubRepositoryDocuments(repositoryId)).map((document) => ({
      repositoryId,
      sourceKey: document.sourceKey as `github:${string}:${string}`,
      relativePath: document.sourceDescriptor.relativePath,
      blobSha: document.sourceDescriptor.blobSha,
    }))
  ))).flat();
}

async function runReport(input: {
  runId: string;
  trigger: GitHubSyncTrigger;
  repositoryIds: readonly string[];
  jobs: readonly GitHubSourceJobRecord[];
}): Promise<GitHubIncrementalRunReport> {
  const [storedRepositories, documents] = await Promise.all([
    getGitHubRepositoryStorageSummaries(),
    currentDocuments(input.repositoryIds),
  ]);
  return projectGitHubIncrementalRun({
    ...input,
    storedRepositories,
    currentDocuments: documents,
  });
}

function approvedPreviews(
  request: ReturnType<typeof parseGitHubIncrementalSyncRequest>,
  jobs: readonly GitHubSourceJobRecord[],
) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const approved = request.approvedPreviewJobIds.map((jobId) => {
    const job = byId.get(jobId);
    if (
      !job
      || job.kind !== "preview"
      || job.status !== "completed"
      || !job.result?.preview
      || job.input.syncRunId !== request.runId
      || job.input.selectedRepositoryIds.length !== 1
    ) {
      throw new GitHubSourceContractError(`승인 가능한 완료 Preview가 아닙니다: ${jobId}`);
    }
    return job;
  });
  const approvedRepositoryIds = approved.map((job) => job.input.selectedRepositoryIds[0])
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(approvedRepositoryIds) !== JSON.stringify(request.repositoryIds)) {
    throw new GitHubSourceContractError("승인 Preview의 저장소와 repositoryIds가 일치하지 않습니다.");
  }
  return approved;
}

export async function GET(request: Request) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const runId = new URL(request.url).searchParams.get("runId")?.trim() ?? "";
    if (!runIdPattern.test(runId)) {
      throw new GitHubSourceContractError("runId query가 필요합니다.");
    }
    const repository = await getGitHubSourceJobRepository();
    const jobs = await repository.list();
    const runJobs = jobs.filter((job) => job.input.syncRunId === runId);
    if (!runJobs.length) {
      return NextResponse.json(
        { error: "GitHub 증분 동기화 run을 찾을 수 없습니다.", code: "not_found" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    const repositoryIds = [...new Set(runJobs.flatMap((job) => job.input.selectedRepositoryIds))];
    const trigger = [...runJobs].reverse().find((job) => job.input.syncTrigger)?.input.syncTrigger
      ?? "manual";
    return NextResponse.json(
      await runReport({ runId, trigger, repositoryIds, jobs }),
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
    const requested = parseGitHubIncrementalSyncRequest(await readLimitedJson(request, 64_000));
    const repository = await getGitHubSourceJobRepository();
    const operations: OperationReceipt[] = [];

    if (requested.action === "preview") {
      for (const repositoryId of requested.repositoryIds) {
        try {
          const input = await parseGitHubSourceJobRequest({
            kind: "preview",
            owner: "coreline-ai",
            selectedRepositoryIds: [repositoryId],
            requestNonce: `${requested.runId}:${repositoryId}`,
            syncTrigger: requested.trigger,
            syncRunId: requested.runId,
          });
          const result = await repository.enqueue(input);
          operations.push({
            repositoryId,
            status: result.created ? "created" : "reused",
            jobId: result.job.id,
          });
        } catch (error) {
          operations.push(isolatedError(repositoryId, error));
        }
      }
    } else {
      const beforeJobs = await repository.list();
      const approved = approvedPreviews(requested, beforeJobs);
      const before = await runReport({
        runId: requested.runId,
        trigger: requested.trigger,
        repositoryIds: requested.repositoryIds,
        jobs: beforeJobs,
      });
      const beforeById = new Map(before.repositories.map((item) => [item.repositoryId, item]));
      const previewByRepository = new Map(approved.map((job) => [
        job.input.selectedRepositoryIds[0],
        job,
      ]));
      for (const repositoryId of requested.repositoryIds) {
        const projection = beforeById.get(repositoryId);
        const previewJob = previewByRepository.get(repositoryId)!;
        if (projection?.status === "unchanged") {
          operations.push({ repositoryId, status: "unchanged", jobId: previewJob.id });
          continue;
        }
        if (projection?.status === "blocked") {
          operations.push({
            repositoryId,
            status: "blocked",
            jobId: previewJob.id,
            message: projection.message,
          });
          continue;
        }
        if (projection?.status !== "changed") {
          operations.push({
            repositoryId,
            status: "rejected",
            jobId: previewJob.id,
            errorCode: "invalid_input",
            message: `Apply 가능한 변경 상태가 아닙니다: ${projection?.status ?? "unknown"}`,
          });
          continue;
        }
        try {
          const preview = previewJob.result!.preview!;
          const requestedInput = await parseGitHubSourceJobRequest({
            kind: "apply",
            owner: "coreline-ai",
            selectedRepositoryIds: [repositoryId],
            manifestDigest: preview.manifestDigest,
            requestNonce: `${requested.runId}:${repositoryId}`,
            syncTrigger: "manual",
            syncRunId: requested.runId,
          });
          const input = await attachGitHubApplyReusePlan(requestedInput, beforeJobs);
          const result = await repository.enqueue(input);
          operations.push({
            repositoryId,
            status: result.created
              ? "created"
              : result.job.input.syncRunId === requested.runId
                ? "reused"
                : "active_elsewhere",
            jobId: result.job.id,
          });
        } catch (error) {
          operations.push(isolatedError(repositoryId, error));
        }
      }
    }

    const jobs = await repository.list();
    const report = await runReport({
      runId: requested.runId,
      trigger: requested.trigger,
      repositoryIds: requested.repositoryIds,
      jobs,
    });
    return NextResponse.json(
      { action: requested.action, ...report, operations },
      {
        status: operations.some((operation) => operation.status === "created") ? 202 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return githubSourceApiError(error);
  }
}
