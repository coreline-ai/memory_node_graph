import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../lib/auth/connector-access";
import { parseGitHubCapabilityReport } from "../../../../lib/github/source-job-contracts";
import { githubSourceApiError } from "../../../../lib/http/github-source-api";
import { readLimitedJson } from "../../../../lib/http/enrichment-api";
import { getGitHubSourceJobRepository } from "../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireAtlasConnectorAccess(request, { limitPerMinute: 120 });
  if ("response" in access) return access.response;
  try {
    const report = parseGitHubCapabilityReport(await readLimitedJson(request, 8_000));
    const capability = await (await getGitHubSourceJobRepository()).recordCapability({
      connectorId: access.connectorId,
      ...report,
    });
    return NextResponse.json(
      { capability },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return githubSourceApiError(error);
  }
}
