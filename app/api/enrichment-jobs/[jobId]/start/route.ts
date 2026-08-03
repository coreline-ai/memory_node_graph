import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../lib/auth/connector-access";
import { enrichmentApiError } from "../../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request);
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const repository = await getEnrichmentJobRepository();
    return NextResponse.json({
      job: await repository.markRunning({ jobId, connectorId: access.connectorId }),
    });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
