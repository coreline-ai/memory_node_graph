import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../lib/auth/write-access";
import {
  deletedDocumentMutationReceipt,
  documentMutationResponse,
} from "../../../lib/ingestion/document-mutation-receipt";
import {
  deleteDocument,
  findDocumentById,
  getDashboardSnapshot,
} from "../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;

  const { documentId } = await context.params;
  const document = await findDocumentById(documentId);
  if (!document) {
    return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });
  }
  await deleteDocument(documentId);
  const snapshot = await getDashboardSnapshot();
  return NextResponse.json({
    ...documentMutationResponse([
      deletedDocumentMutationReceipt(document),
    ], snapshot),
    ok: true,
  });
}
