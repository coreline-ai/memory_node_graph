import { NextResponse } from "next/server";
import { projectGitHubRuntimeStatus } from "../../../../lib/github/github-runtime-status";
import { getGitHubSourceJobRepository } from "../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const capabilities = await (await getGitHubSourceJobRepository()).listRuntimeCapabilities();
  return NextResponse.json(
    { runtime: projectGitHubRuntimeStatus(capabilities) },
    { headers: { "cache-control": "no-store" } },
  );
}
