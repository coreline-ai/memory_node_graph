import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../lib/auth/connector-access";
import { enrichmentApiError, readLimitedJson } from "../../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request);
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const body = await readLimitedJson(request, 8_000) as { leaseDurationMs?: unknown };
    const leaseDurationMs = Math.min(300_000, Math.max(15_000, Number(body.leaseDurationMs) || 60_000));
    const repository = await getEnrichmentJobRepository();
    return NextResponse.json({
      job: await repository.renewLease({ jobId, connectorId: access.connectorId, leaseDurationMs }),
    });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
