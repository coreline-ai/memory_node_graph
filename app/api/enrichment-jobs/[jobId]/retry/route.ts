import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../../lib/auth/write-access";
import { enrichmentApiError } from "../../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../../lib/storage/enrichment-job-repository";
import {
  getDashboardSnapshot,
  removeMemoryEnrichmentResult,
} from "../../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const { jobId } = await context.params;
    const repository = await getEnrichmentJobRepository();
    const previous = await repository.get(jobId);
    const job = await repository.retry(jobId);
    if (previous) await removeMemoryEnrichmentResult(jobId, previous.documentId);
    return NextResponse.json({ job, snapshot: await getDashboardSnapshot() });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
