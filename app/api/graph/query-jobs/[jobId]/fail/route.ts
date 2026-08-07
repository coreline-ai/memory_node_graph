import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../../lib/auth/connector-access";
import { enrichmentApiError, asObject, readLimitedJson } from "../../../../../lib/http/enrichment-api";
import {
  GRAPH_ANSWER_ERROR_CODES,
  type GraphAnswerErrorCode,
} from "../../../../../lib/llm/graph-answer-contracts";
import { getGraphAnswerJobRepository } from "../../../../../lib/storage/graph-answer-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request);
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const body = asObject(await readLimitedJson(request, 16_000));
    const candidate = String(body.errorCode ?? "unknown") as GraphAnswerErrorCode;
    const errorCode = GRAPH_ANSWER_ERROR_CODES.includes(candidate) ? candidate : "unknown";
    const job = await (await getGraphAnswerJobRepository()).fail({
      jobId,
      connectorId: access.connectorId,
      errorCode,
      errorMessage: String(body.errorMessage ?? "Connector 답변 생성 실패").slice(0, 1_000),
      retryable: body.retryable === true,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
