import { NextResponse } from "next/server";
import { getDashboardSnapshot } from "../../../lib/storage/graph-repository";
import { requireAtlasReadAccess } from "../../../lib/auth/write-access";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const unauthorized = requireAtlasReadAccess(request);
  if (unauthorized) return unauthorized;
  const { jobId } = await context.params;
  const snapshot = await getDashboardSnapshot();
  const job = snapshot.jobs.find((candidate) => candidate.id === jobId);
  return job
    ? NextResponse.json(job)
    : NextResponse.json({ error: "작업을 찾을 수 없습니다." }, { status: 404 });
}
