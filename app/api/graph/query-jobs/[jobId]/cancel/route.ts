import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../../../lib/auth/write-access";
import { enrichmentApiError } from "../../../../../lib/http/enrichment-api";
import { getGraphAnswerJobRepository } from "../../../../../lib/storage/graph-answer-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const { jobId } = await context.params;
    return NextResponse.json({ job: await (await getGraphAnswerJobRepository()).cancel(jobId) });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
