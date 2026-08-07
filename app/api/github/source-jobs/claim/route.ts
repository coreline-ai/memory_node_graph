import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../lib/auth/connector-access";
import { githubSourceApiError } from "../../../../lib/http/github-source-api";
import { readLimitedJson } from "../../../../lib/http/enrichment-api";
import { getGitHubSourceJobRepository } from "../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireAtlasConnectorAccess(request, { limitPerMinute: 60 });
  if ("response" in access) return access.response;
  try {
    const body = await readLimitedJson(request, 8_000) as { leaseDurationMs?: unknown };
    const leaseDurationMs = Math.min(
      300_000,
      Math.max(15_000, Number(body.leaseDurationMs) || 60_000),
    );
    const job = await (await getGitHubSourceJobRepository()).claim({
      connectorId: access.connectorId,
      leaseDurationMs,
    });
    return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return githubSourceApiError(error);
  }
}
