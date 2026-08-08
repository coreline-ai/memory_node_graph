import { NextResponse } from "next/server";
import { requireAtlasRuntimeAccess } from "../../../../../lib/auth/runtime-access";
import {
  GITHUB_APPLY_CHUNK_MAX_BYTES,
  parseGitHubApplyStageChunk,
} from "../../../../../lib/github/apply-stage-contracts";
import { assertCredentialFreePayload } from "../../../../../lib/github/source-job-contracts";
import { githubSourceApiError } from "../../../../../lib/http/github-source-api";
import { readLimitedJson } from "../../../../../lib/http/enrichment-api";
import {
  getGitHubSourceJobRepository,
  GitHubSourceRepositoryError,
} from "../../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasRuntimeAccess(request, { limitPerMinute: 240 });
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const repository = await getGitHubSourceJobRepository();
    const current = await repository.get(jobId);
    if (!current || current.kind !== "apply") {
      throw new GitHubSourceRepositoryError("invalid_input", "Apply source 작업을 찾을 수 없습니다.");
    }
    if (
      !["leased", "running"].includes(current.status)
      || current.leaseOwner !== access.runtimeId
      || !current.leaseExpiresAt
      || Date.parse(current.leaseExpiresAt) <= Date.now()
    ) throw new GitHubSourceRepositoryError("lease_conflict", "현재 통합 런타임가 소유한 유효 Lease가 아닙니다.");
    try {
      const submitted = await readLimitedJson(request, GITHUB_APPLY_CHUNK_MAX_BYTES + 256_000);
      assertCredentialFreePayload(submitted);
      const chunk = await parseGitHubApplyStageChunk(submitted, jobId);
      const receivedChunks = await repository.putApplyStageChunk(chunk);
      return NextResponse.json({
        stage: {
          receivedChunks,
          totalChunks: chunk.totalChunks,
          chunkIndex: chunk.chunkIndex,
          checksum: chunk.checksum,
        },
      });
    } catch (error) {
      await repository.deleteApplyStageChunks(jobId).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return githubSourceApiError(error);
  }
}
