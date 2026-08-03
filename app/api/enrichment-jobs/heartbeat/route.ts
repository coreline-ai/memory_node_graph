import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../lib/auth/connector-access";
import { asObject, enrichmentApiError, readLimitedJson } from "../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/;

export async function POST(request: Request) {
  const access = await requireAtlasConnectorAccess(request, { limitPerMinute: 120 });
  if ("response" in access) return access.response;
  try {
    const body = asObject(await readLimitedJson(request, 4_000));
    const status = body.status === "offline" ? "offline" : "online";
    const version = typeof body.version === "string" && versionPattern.test(body.version)
      ? body.version
      : "unknown";
    const currentJobId = typeof body.currentJobId === "string"
      ? body.currentJobId.slice(0, 160)
      : undefined;
    const heartbeat = await (await getEnrichmentJobRepository()).recordConnectorHeartbeat({
      connectorId: access.connectorId,
      status,
      version,
      currentJobId,
    });
    return NextResponse.json({ heartbeat }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
