import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../lib/auth/connector-access";
import { enrichmentApiError, readLimitedJson } from "../../../../lib/http/enrichment-api";
import { validateEnrichmentResult } from "../../../../lib/llm/enrichment-result-validator";
import { getEnrichmentJobRepository } from "../../../../lib/storage/enrichment-job-repository";
import { findDocumentById, mergeMemoryEnrichmentResult } from "../../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request, { limitPerMinute: 120 });
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const repository = await getEnrichmentJobRepository();
    const job = await repository.get(jobId);
    if (!job) return NextResponse.json({ error: "보강 작업을 찾을 수 없습니다." }, { status: 404 });
    const result = validateEnrichmentResult(await readLimitedJson(request), job);
    const document = await findDocumentById(job.documentId);
    const completed = await repository.complete({
      jobId,
      connectorId: access.connectorId,
      currentDocumentHash: document?.hash ?? "",
      result,
    });
    if (completed.status === "completed" || completed.status === "warning") {
      await mergeMemoryEnrichmentResult(job.documentId, result);
    }
    return NextResponse.json({ job: completed });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
