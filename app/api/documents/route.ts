import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../lib/auth/write-access";
import { ingestMarkdown, MAX_MARKDOWN_FILES } from "../../lib/ingestion/ingestion-service";
import { validateDecodedMarkdown } from "../../lib/markdown/validate-markdown";
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
    const results = [];
    for (const file of files) {
      const source = await file.text();
      validateDecodedMarkdown(file.name, source, file.size);
      results.push(await ingestMarkdown({ fileName: file.name, source, size: file.size }));
    }
    return NextResponse.json({ results, snapshot: await getDashboardSnapshot() }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "문서를 처리하지 못했습니다." },
      { status: 400 },
    );
  }
}
