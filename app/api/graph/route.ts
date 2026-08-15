import { NextResponse } from "next/server";
import { createPerformanceGraphSnapshot } from "../../lib/graph/performance-fixture";
import { createGoldGraphSnapshot } from "../../lib/graph/gold-graph-fixture";
import { consolidateGraphSnapshot } from "../../lib/graph/consolidation";
import { analyzeGraphSnapshot } from "../../lib/graph/analytics";
import {
  projectGraphCorpus,
  projectGraphDocument,
  projectGraphOverview,
  projectGraphRepository,
} from "../../lib/graph/scope-projection";
import { getGraphSnapshotForScope } from "../../lib/storage/graph-repository";
import { requireAtlasReadAccess } from "../../lib/auth/write-access";
import { internalApiError } from "../../lib/http/api-error";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const showcase = params.get("showcase");
    const fixture = params.get("fixture");
    const scope = params.get("scope");
    if (scope !== null && scope !== "corpus" && scope !== "overview" && scope !== "repository" && scope !== "document") {
      return NextResponse.json(
        { error: "지원하지 않는 그래프 scope입니다.", code: "invalid_scope" },
        { status: 400 },
      );
    }
    const repositoryId = params.get("repositoryId");
    if (scope === "repository" && repositoryId === null) {
      return NextResponse.json(
        { error: "repository scope에는 repositoryId가 필요합니다.", code: "repository_id_required" },
        { status: 400 },
      );
    }
    if (scope === "repository" && !/^[1-9][0-9]*$/.test(repositoryId!)) {
      return NextResponse.json(
        { error: "repositoryId는 0이 아닌 숫자 문자열이어야 합니다.", code: "invalid_repository_id" },
        { status: 400 },
      );
    }
    const documentId = params.get("documentId");
    if (scope === "document" && documentId === null) {
      return NextResponse.json(
        { error: "document scope에는 documentId가 필요합니다.", code: "document_id_required" },
        { status: 400 },
      );
    }
    if (scope === "document" && !/^[A-Za-z0-9:_-]{8,220}$/.test(documentId!)) {
      return NextResponse.json(
        { error: "documentId 형식이 올바르지 않습니다.", code: "invalid_document_id" },
        { status: 400 },
      );
    }
    if (showcase === "max") {
      return NextResponse.json(analyzeGraphSnapshot(createPerformanceGraphSnapshot()), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (showcase === "gold" || (process.env.NODE_ENV !== "production" && fixture === "gold-v1")) {
      return NextResponse.json(analyzeGraphSnapshot(createGoldGraphSnapshot()), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (process.env.NODE_ENV !== "production" && fixture === "500x2000") {
      return NextResponse.json(analyzeGraphSnapshot(createPerformanceGraphSnapshot()), {
        headers: { "cache-control": "no-store" },
      });
    }
    const unauthorized = requireAtlasReadAccess(request);
    if (unauthorized) return unauthorized;
    const effectiveScope = scope ?? "corpus";
    const storedSnapshot = await getGraphSnapshotForScope({
      scope: effectiveScope,
      repositoryId: repositoryId ?? undefined,
      documentId: documentId ?? undefined,
    });
    const snapshot = consolidateGraphSnapshot(storedSnapshot);
    if (scope === "repository") {
      const projected = projectGraphRepository(snapshot, repositoryId!);
      if (!projected) {
        return NextResponse.json(
          { error: "동기화된 GitHub 저장소를 찾을 수 없습니다.", code: "repository_not_found" },
          { status: 404 },
        );
      }
      return NextResponse.json(analyzeGraphSnapshot(projected), { headers: { "cache-control": "no-store" } });
    }
    if (scope === "document") {
      const projected = projectGraphDocument(snapshot, documentId!);
      if (!projected) {
        return NextResponse.json(
          { error: "분석 완료된 Markdown 문서를 찾을 수 없습니다.", code: "document_not_found" },
          { status: 404 },
        );
      }
      return NextResponse.json(analyzeGraphSnapshot(projected), { headers: { "cache-control": "no-store" } });
    }
    const responseSnapshot = effectiveScope === "corpus"
      ? projectGraphCorpus(snapshot)
      : effectiveScope === "overview"
        ? projectGraphOverview(snapshot)
        : snapshot;
    return NextResponse.json(
      responseSnapshot.nodes.length <= 5_000 && responseSnapshot.edges.length <= 20_000
        ? analyzeGraphSnapshot(responseSnapshot)
        : responseSnapshot,
      {
      headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return internalApiError(error, { message: "그래프를 불러오지 못했습니다.", scope: "graph" });
  }
}
