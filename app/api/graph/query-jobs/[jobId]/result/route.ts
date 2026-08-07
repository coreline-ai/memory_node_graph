import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../../lib/auth/connector-access";
import { enrichmentApiError, readLimitedJson } from "../../../../../lib/http/enrichment-api";
import { validateGraphAnswerResult } from "../../../../../lib/llm/graph-answer-result-validator";
import { getGraphAnswerJobRepository } from "../../../../../lib/storage/graph-answer-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request, { limitPerMinute: 120 });
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const repository = await getGraphAnswerJobRepository();
    const job = await repository.get(jobId);
    if (!job) return NextResponse.json({ error: "그래프 답변 작업을 찾을 수 없습니다." }, { status: 404 });
    const result = validateGraphAnswerResult(await readLimitedJson(request), job);
    return NextResponse.json({
      job: await repository.complete({ jobId, connectorId: access.connectorId, result }),
    });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
