import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../../lib/auth/connector-access";
import { enrichmentApiError } from "../../../../../lib/http/enrichment-api";
import { getGraphAnswerJobRepository } from "../../../../../lib/storage/graph-answer-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request);
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const job = await (await getGraphAnswerJobRepository()).markRunning({
      jobId,
      connectorId: access.connectorId,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
