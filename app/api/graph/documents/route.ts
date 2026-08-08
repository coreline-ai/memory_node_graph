import { NextResponse } from "next/server";
import { listGraphDocuments } from "../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const value = Number(new URL(request.url).searchParams.get("limit") ?? 8);
    const limit = Number.isSafeInteger(value) ? Math.max(1, Math.min(12, value)) : 8;
    return NextResponse.json(
      { documents: await listGraphDocuments(limit) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "최근 문서를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
