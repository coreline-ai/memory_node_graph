import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../../lib/auth/write-access";
import { reindexDocument } from "../../../../lib/ingestion/ingestion-service";
import {
  completedDocumentMutationReceipt,
  documentMutationResponse,
} from "../../../../lib/ingestion/document-mutation-receipt";
import { getDashboardSnapshot } from "../../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;

  try {
    const { documentId } = await context.params;
    const result = await reindexDocument(documentId);
    const receipt = completedDocumentMutationReceipt({
      document: result.document,
      operation: "reindexed",
      before: result.before,
      message: result.job.message,
      warning: result.enrichmentWarning,
    });
    const snapshot = await getDashboardSnapshot();
    return NextResponse.json({
      ...documentMutationResponse([receipt], snapshot),
      result,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "재인덱싱하지 못했습니다." },
      { status: 404 },
    );
  }
}
