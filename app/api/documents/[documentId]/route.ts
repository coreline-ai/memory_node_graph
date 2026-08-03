import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../lib/auth/write-access";
import { deleteDocument, getDashboardSnapshot } from "../../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;

  const { documentId } = await context.params;
  await deleteDocument(documentId);
  return NextResponse.json({ ok: true, snapshot: await getDashboardSnapshot() });
}
