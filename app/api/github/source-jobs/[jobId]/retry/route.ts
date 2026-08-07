import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../../../lib/auth/write-access";
import { githubSourceApiError } from "../../../../../lib/http/github-source-api";
import { getGitHubSourceJobRepository } from "../../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const { jobId } = await context.params;
    const job = await (await getGitHubSourceJobRepository()).retry(jobId);
    return NextResponse.json({ job });
  } catch (error) {
    return githubSourceApiError(error);
  }
}
