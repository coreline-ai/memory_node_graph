import { NextResponse } from "next/server";
import { listGraphDocuments } from "../../../lib/storage/graph-repository";
import { requireAtlasReadAccess } from "../../../lib/auth/write-access";
import { internalApiError } from "../../../lib/http/api-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAtlasReadAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const value = Number(new URL(request.url).searchParams.get("limit") ?? 8);
    const limit = Number.isSafeInteger(value) ? Math.max(1, Math.min(12, value)) : 8;
    return NextResponse.json(
      { documents: await listGraphDocuments(limit) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return internalApiError(error, { message: "최근 문서를 불러오지 못했습니다.", scope: "graph-documents" });
  }
}
