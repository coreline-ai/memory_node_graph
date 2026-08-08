import { NextResponse } from "next/server";
import { getCodexRuntimeStatus } from "../../../../lib/llm/codex-runtime-service";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    { runtime: await getCodexRuntimeStatus() },
    { headers: { "cache-control": "no-store" } },
  );
}
