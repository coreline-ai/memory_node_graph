import { NextResponse } from "next/server";
import { requireAtlasRuntimeAccess } from "../../../../../lib/auth/runtime-access";
import {
  GITHUB_SOURCE_ERROR_CODES,
  type GitHubSourceErrorCode,
} from "../../../../../lib/github/source-job-contracts";
import { githubSourceApiError } from "../../../../../lib/http/github-source-api";
import { asObject, readLimitedJson } from "../../../../../lib/http/enrichment-api";
import { getGitHubSourceJobRepository } from "../../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasRuntimeAccess(request);
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const body = asObject(await readLimitedJson(request, 16_000));
    const candidate = String(body.errorCode ?? "unknown") as GitHubSourceErrorCode;
    const errorCode = GITHUB_SOURCE_ERROR_CODES.includes(candidate) ? candidate : "unknown";
    const errorMessage = String(body.errorMessage ?? "GitHub source 통합 런타임 작업 실패")
      .slice(0, 1_000);
    const job = await (await getGitHubSourceJobRepository()).fail({
      jobId,
      runtimeId: access.runtimeId,
      errorCode,
      errorMessage,
      retryable: body.retryable === true,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return githubSourceApiError(error);
  }
}
