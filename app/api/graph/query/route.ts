import { NextResponse } from "next/server";
import {
  GraphQueryValidationError,
  normalizeGraphQueryLimits,
  normalizeGraphQuestion,
  retrieveGraphContext,
} from "../../../lib/graph/graph-retrieval";
import { asObject, readLimitedJson } from "../../../lib/http/enrichment-api";
import { requireAtlasWriteAccess } from "../../../lib/auth/write-access";
import { getCodexConnectorAvailability } from "../../../lib/llm/connector-availability";
import {
  buildGraphAnswerJobInput,
  GRAPH_ANSWER_PROVIDER_VERSION,
} from "../../../lib/llm/graph-answer-contracts";
import { getGraphAnswerJobRepository } from "../../../lib/storage/graph-answer-job-repository";
import { getGraphRetrievalSource } from "../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

const executeQuery = async (question: unknown, rawLimits: unknown) => {
  const query = normalizeGraphQuestion(question);
  const limits = normalizeGraphQueryLimits(rawLimits);
  const source = await getGraphRetrievalSource(query);
  return retrieveGraphContext({ query, source, limits });
};

const errorResponse = (error: unknown) => {
  if (error instanceof GraphQueryValidationError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      error: error instanceof Error ? error.message : "그래프 근거를 검색하지 못했습니다.",
      code: "graph_query_failed",
    },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
};

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    return NextResponse.json(await executeQuery(params.get("q"), {
      nodes: params.get("nodes") ?? undefined,
      relations: params.get("relations") ?? undefined,
      citations: params.get("citations") ?? undefined,
    }), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = asObject(await readLimitedJson(request, 8_000));
    const retrieval = await executeQuery(body.question, body.limits);
    if (body.generateAnswer !== true) {
      return NextResponse.json(retrieval, {
        headers: { "cache-control": "no-store" },
      });
    }
    const unauthorized = requireAtlasWriteAccess(request);
    if (unauthorized) return unauthorized;
    if (!retrieval.meta.answerReady) {
      return NextResponse.json({
        ...retrieval,
        answer: {
          status: "insufficient_evidence",
          jobId: null,
          result: null,
          message: "인용 가능한 검색 근거가 부족해 Codex 답변 생성을 보류했습니다.",
        },
      }, { headers: { "cache-control": "no-store" } });
    }
    const connector = await getCodexConnectorAvailability();
    if (connector.status !== "online") {
      return NextResponse.json({
        ...retrieval,
        answer: {
          status: "connector_offline",
          jobId: null,
          result: null,
          connector,
          message: "로컬 OAuth Connector가 오프라인이라 검색 근거만 반환했습니다.",
        },
      }, { headers: { "cache-control": "no-store" } });
    }
    const input = await buildGraphAnswerJobInput({
      retrieval,
      providerVersion: GRAPH_ANSWER_PROVIDER_VERSION,
    });
    const { job, created } = await (await getGraphAnswerJobRepository()).enqueue(input);
    return NextResponse.json({
      ...retrieval,
      answer: {
        status: job.status,
        jobId: job.id,
        result: job.result ?? null,
        connector,
        created,
        message: job.status === "completed"
          ? "검색 context와 다시 검증된 Codex 답변입니다."
          : "검색 context를 고정한 Codex 답변 작업을 등록했습니다.",
      },
    }, {
      status: created ? 202 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
