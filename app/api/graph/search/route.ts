import { NextResponse } from "next/server";
import {
  GraphQueryValidationError,
  normalizeGraphQuestion,
} from "../../../lib/graph/graph-retrieval";
import { searchGraphNodeIndex } from "../../../lib/storage/graph-repository";
import { requireAtlasReadAccess } from "../../../lib/auth/write-access";
import { internalApiError } from "../../../lib/http/api-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAtlasReadAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const params = new URL(request.url).searchParams;
    const query = normalizeGraphQuestion(params.get("q"));
    const parsedLimit = Number(params.get("limit") ?? 8);
    const limit = Number.isSafeInteger(parsedLimit)
      ? Math.max(1, Math.min(12, parsedLimit))
      : 8;
    return NextResponse.json(
      { query: query.normalized, results: await searchGraphNodeIndex(query, limit) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof GraphQueryValidationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 },
      );
    }
    return internalApiError(error, { message: "지식 노드를 검색하지 못했습니다.", scope: "graph-search" });
  }
}
