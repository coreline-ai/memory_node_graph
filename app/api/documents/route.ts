import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../lib/auth/write-access";
import { ingestMarkdown, MAX_MARKDOWN_FILES } from "../../lib/ingestion/ingestion-service";
import {
  completedDocumentMutationReceipt,
  documentMutationResponse,
  failedDocumentMutationReceipt,
} from "../../lib/ingestion/document-mutation-receipt";
import { decodeMarkdownBytes } from "../../lib/markdown/validate-markdown";
import { getDashboardSnapshot } from "../../lib/storage/graph-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getDashboardSnapshot(), {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;

  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    if (!files.length) {
      return NextResponse.json({ error: "Markdown 파일을 한 개 이상 선택하세요." }, { status: 400 });
    }
    if (files.length > MAX_MARKDOWN_FILES) {
      return NextResponse.json({ error: `한 번에 최대 ${MAX_MARKDOWN_FILES}개까지 추가할 수 있습니다.` }, { status: 400 });
    }
    const receipts = [];
    const results = [];
    for (const file of files) {
      try {
        const source = decodeMarkdownBytes(file.name, await file.arrayBuffer());
        const result = await ingestMarkdown({ fileName: file.name, source, size: file.size });
        results.push(result);
        receipts.push(completedDocumentMutationReceipt({
          document: result.document,
          operation: result.operation,
          before: result.before,
          message: result.job.message,
          warning: result.enrichmentWarning,
        }));
      } catch (error) {
        receipts.push(failedDocumentMutationReceipt(file.name, error));
      }
    }
    const snapshot = await getDashboardSnapshot();
    const response = documentMutationResponse(receipts, snapshot);
    const successful = response.summary.completed + response.summary.unchanged;
    const status = response.summary.failed
      ? successful ? 207 : 400
      : 201;
    return NextResponse.json({
      ...response,
      results,
      ...(successful ? {} : { error: receipts[0]?.message ?? "문서를 처리하지 못했습니다." }),
    }, { status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "문서를 처리하지 못했습니다." },
      { status: 400 },
    );
  }
}
