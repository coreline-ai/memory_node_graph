import { NextResponse } from "next/server";
import { createPerformanceGraphSnapshot } from "../../lib/graph/performance-fixture";
import { getGraphSnapshot } from "../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const showcase = params.get("showcase");
    const fixture = params.get("fixture");
    if (showcase === "max") {
      return NextResponse.json(createPerformanceGraphSnapshot(), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (process.env.NODE_ENV !== "production" && fixture === "500x2000") {
      return NextResponse.json(createPerformanceGraphSnapshot(), {
        headers: { "cache-control": "no-store" },
      });
    }
    return NextResponse.json(await getGraphSnapshot(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "그래프를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
