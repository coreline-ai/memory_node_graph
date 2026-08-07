import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../../lib/auth/write-access";
import { githubSourceApiError } from "../../../../lib/http/github-source-api";
import { getGitHubSourceJobRepository } from "../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const { jobId } = await context.params;
    const job = await (await getGitHubSourceJobRepository()).get(jobId);
    return job
      ? NextResponse.json({ job }, { headers: { "cache-control": "no-store" } })
      : NextResponse.json(
        { error: "GitHub source 작업을 찾을 수 없습니다.", code: "not_found" },
        { status: 404 },
      );
  } catch (error) {
    return githubSourceApiError(error);
  }
}
