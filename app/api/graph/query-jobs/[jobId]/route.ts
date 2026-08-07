import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../../lib/auth/write-access";
import { enrichmentApiError } from "../../../../lib/http/enrichment-api";
import { getGraphAnswerJobRepository } from "../../../../lib/storage/graph-answer-job-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const { jobId } = await context.params;
    const job = await (await getGraphAnswerJobRepository()).get(jobId);
    return job
      ? NextResponse.json({ job }, { headers: { "cache-control": "no-store" } })
      : NextResponse.json({ error: "그래프 답변 작업을 찾을 수 없습니다." }, { status: 404 });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
