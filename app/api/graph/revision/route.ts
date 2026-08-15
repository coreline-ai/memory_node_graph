import { NextResponse } from "next/server";
import { getGraphRevision } from "../../../lib/storage/graph-repository";
import { requireAtlasReadAccess } from "../../../lib/auth/write-access";
import { internalApiError } from "../../../lib/http/api-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAtlasReadAccess(request);
  if (unauthorized) return unauthorized;
  try {
    return NextResponse.json({ graphRevision: await getGraphRevision() }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return internalApiError(error, { message: "그래프 revision을 확인하지 못했습니다.", scope: "graph-revision" });
  }
}
