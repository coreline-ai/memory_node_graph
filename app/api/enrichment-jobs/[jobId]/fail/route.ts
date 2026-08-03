import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../lib/auth/connector-access";
import { ENRICHMENT_ERROR_CODES, type EnrichmentErrorCode } from "../../../../lib/llm/enrichment-contracts";
import { asObject, enrichmentApiError, readLimitedJson } from "../../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request);
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const body = asObject(await readLimitedJson(request, 16_000));
    const code = String(body.errorCode ?? "unknown") as EnrichmentErrorCode;
    const errorCode = ENRICHMENT_ERROR_CODES.includes(code) ? code : "unknown";
    const errorMessage = String(body.errorMessage ?? "Connector 작업 실패").slice(0, 1_000);
    const repository = await getEnrichmentJobRepository();
    return NextResponse.json({
      job: await repository.fail({
        jobId,
        connectorId: access.connectorId,
        errorCode,
        errorMessage,
        retryable: body.retryable === true,
      }),
    });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
