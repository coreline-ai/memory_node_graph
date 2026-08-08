import { NextResponse } from "next/server";
import { requireAtlasRuntimeAccess } from "../../../../lib/auth/runtime-access";
import { GitHubSourceContractError } from "../../../../lib/github/source-job-contracts";
import { githubSourceApiError } from "../../../../lib/http/github-source-api";
import { readLimitedJson } from "../../../../lib/http/enrichment-api";
import { getGitHubSourceJobRepository } from "../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireAtlasRuntimeAccess(request, { limitPerMinute: 60 });
  if ("response" in access) return access.response;
  try {
    const body = await readLimitedJson(request, 8_000) as {
      leaseDurationMs?: unknown;
      runtimeVersion?: unknown;
    };
    const leaseDurationMs = Math.min(
      300_000,
      Math.max(15_000, Number(body.leaseDurationMs) || 60_000),
    );
    if (body.runtimeVersion !== undefined && typeof body.runtimeVersion !== "string") {
      throw new GitHubSourceContractError("GitHub runtimeVersion은 문자열이어야 합니다.");
    }
    const runtimeVersion = body.runtimeVersion?.trim() || undefined;
    if (runtimeVersion && !/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,79}$/.test(runtimeVersion)) {
      throw new GitHubSourceContractError("GitHub runtimeVersion 형식이 잘못되었습니다.");
    }
    const job = await (await getGitHubSourceJobRepository()).claim({
      runtimeId: access.runtimeId,
      leaseDurationMs,
      runtimeVersion,
    });
    return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return githubSourceApiError(error);
  }
}
