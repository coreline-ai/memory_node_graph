import { NextResponse } from "next/server";
import { requireAtlasRuntimeAccess } from "../../../lib/auth/runtime-access";
import { enrichmentApiError } from "../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasRuntimeAccess(request);
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const job = await (await getEnrichmentJobRepository()).get(jobId);
    return job
      ? NextResponse.json({ job }, { headers: { "cache-control": "no-store" } })
      : NextResponse.json({ error: "보강 작업을 찾을 수 없습니다." }, { status: 404 });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
