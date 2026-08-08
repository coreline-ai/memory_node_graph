import { NextResponse } from "next/server";
import { getGraphRevision } from "../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ graphRevision: await getGraphRevision() }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "그래프 revision을 확인하지 못했습니다." },
      { status: 500 },
    );
  }
}
