import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../lib/auth/write-access";
import { reindexDocument } from "../../../lib/ingestion/ingestion-service";
import { estimateEvidenceChunkCount } from "../../../lib/llm/enrichment-contracts";
import {
  getDashboardSnapshot,
  listDocumentReprocessCandidates,
} from "../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

const MAX_REPROCESS_BATCH = 20;

type ReprocessRequest = {
  documentIds?: string[];
  repositoryId?: string;
  includeSnapshot?: boolean;
};

const readInput = async (request: Request): Promise<ReprocessRequest> => {
  if (!request.headers.get("content-type")?.includes("application/json")) return {};
  const payload = await request.json() as ReprocessRequest;
  return {
    repositoryId: typeof payload.repositoryId === "string" ? payload.repositoryId.trim() : undefined,
    includeSnapshot: payload.includeSnapshot !== false,
    documentIds: Array.isArray(payload.documentIds)
      ? [...new Set(payload.documentIds.filter((value): value is string =>
        typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))]
      : undefined,
  };
};

const previewFor = async (input: ReprocessRequest) => {
  const candidates = await listDocumentReprocessCandidates(input);
  const repositories = new Set(candidates.map((item) => item.repositoryId).filter(Boolean));
  return {
    documents: candidates,
    totals: {
      documents: candidates.length,
      repositories: repositories.size,
      blocks: candidates.reduce((sum, item) => sum + item.blockCount, 0),
      chunks: candidates.reduce((sum, item) => sum + estimateEvidenceChunkCount(item.blockCount), 0),
    },
    batchLimit: MAX_REPROCESS_BATCH,
  };
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repositoryId = url.searchParams.get("repositoryId")?.trim() || undefined;
  return NextResponse.json(await previewFor({ repositoryId }), {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const input = await readInput(request);
    const preview = await previewFor(input);
    if (!preview.documents.length) {
      return NextResponse.json({ error: "재처리할 문서가 없습니다." }, { status: 400 });
    }
    if (preview.documents.length > MAX_REPROCESS_BATCH) {
      return NextResponse.json({
        error: `한 요청에서 최대 ${MAX_REPROCESS_BATCH}개 문서만 재처리할 수 있습니다.`,
        preview,
      }, { status: 413 });
    }

    const results = [];
    for (const candidate of preview.documents) {
      try {
        const result = await reindexDocument(candidate.documentId);
        results.push({
          documentId: candidate.documentId,
          status: "completed" as const,
          nodeCount: result.document.nodeCount,
          edgeCount: result.document.edgeCount,
          chunkCount: result.enrichmentSchedule?.chunkCount ?? 0,
          warning: result.enrichmentWarning,
        });
      } catch (error) {
        results.push({
          documentId: candidate.documentId,
          status: "failed" as const,
          error: error instanceof Error ? error.message : "문서 재처리 실패",
        });
      }
    }
    return NextResponse.json({
      preview,
      results,
      completedCount: results.filter((item) => item.status === "completed").length,
      failedCount: results.filter((item) => item.status === "failed").length,
      snapshot: input.includeSnapshot === false ? undefined : await getDashboardSnapshot(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "문서 재처리를 시작하지 못했습니다." },
      { status: 400 },
    );
  }
}
