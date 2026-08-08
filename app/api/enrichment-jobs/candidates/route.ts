import { NextResponse } from "next/server";
import { requireAtlasWriteAccess } from "../../../lib/auth/write-access";
import { asObject, readLimitedJson } from "../../../lib/http/enrichment-api";
import { INTEGRATED_CODEX_PROVIDER_VERSION } from "../../../lib/llm/codex-runtime-status";
import {
  MAX_RELATIONSHIP_CANDIDATE_SELECTION,
  RelationshipCandidateSelectionError,
  rankRelationshipCandidates,
  selectHighRelationshipCandidates,
  summarizeRelationshipCandidateAnchors,
} from "../../../lib/llm/relationship-candidate-score";
import { getEnrichmentJobRepository } from "../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

const MAX_SCAN = 500;
const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;
const MAX_RUNTIME_MS = 900_000;

const integer = (value: string | null, fallback: number, minimum: number, maximum: number) => {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

async function rankedCandidateSource() {
  const page = await (await getEnrichmentJobRepository()).listQueuedByProvider({
    providerVersion: INTEGRATED_CODEX_PROVIDER_VERSION,
    limit: MAX_SCAN,
  });
  const candidates = rankRelationshipCandidates(page.jobs);
  return {
    candidates,
    availableJobs: page.total,
    scannedJobs: page.jobs.length,
    truncated: page.total > page.jobs.length,
  };
}

export async function GET(request: Request) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  const url = new URL(request.url);
  const limit = integer(url.searchParams.get("limit"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = integer(url.searchParams.get("offset"), 0, 0, MAX_SCAN);
  const source = await rankedCandidateSource();
  const highCount = source.candidates.filter((candidate) => candidate.tier === "high").length;
  const reviewCount = source.candidates.filter((candidate) => candidate.tier === "review").length;
  const excludedCount = source.candidates.filter((candidate) => candidate.tier === "excluded").length;
  const anchorAudit = summarizeRelationshipCandidateAnchors(source.candidates);
  return NextResponse.json({
    providerVersion: INTEGRATED_CODEX_PROVIDER_VERSION,
    candidates: source.candidates.slice(offset, offset + limit),
    pagination: {
      limit,
      offset,
      returned: Math.max(0, Math.min(limit, source.candidates.length - offset)),
      totalRanked: source.candidates.length,
      hasMore: offset + limit < source.candidates.length,
    },
    summary: {
      availableJobs: source.availableJobs,
      scannedJobs: source.scannedJobs,
      truncated: source.truncated,
      highCount,
      reviewCount,
      excludedCount,
      ...anchorAudit,
      selectionLimit: MAX_RELATIONSHIP_CANDIDATE_SELECTION,
      message: source.truncated
        ? `현재 provider 대기열 중 처음 ${MAX_SCAN}개만 점수화했습니다. 전체 실행은 하지 않습니다.`
        : "현재 provider의 queued 작업만 읽기 전용으로 점수화했습니다.",
    },
  }, { headers: { "cache-control": "no-store" } });
}

/**
 * Selection preview only. It intentionally cannot claim jobs or start the
 * runtime; the operator must still run the displayed bounded command later.
 */
export async function POST(request: Request) {
  const unauthorized = requireAtlasWriteAccess(request);
  if (unauthorized) return unauthorized;
  try {
    const body = asObject(await readLimitedJson(request, 8_000));
    if (!Array.isArray(body.jobIds)) {
      return NextResponse.json({ error: "jobIds는 문자열 배열이어야 합니다." }, { status: 400 });
    }
    const requestedJobIds = body.jobIds
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter(Boolean);
    const source = await rankedCandidateSource();
    const selected = selectHighRelationshipCandidates(source.candidates, requestedJobIds);
    const jobIds = selected.map((candidate) => candidate.jobId);
    const jobList = jobIds.join(",");
    return NextResponse.json({
      selection: selected,
      preview: {
        mode: "manual_runtime_command",
        jobIds,
        maxJobs: jobIds.length,
        maxRuntimeMs: MAX_RUNTIME_MS,
        enrichmentOnly: true,
        environment: {
          ATLAS_RUNTIME_ENRICHMENT_ONLY: "true",
          ATLAS_RUNTIME_JOB_IDS: jobList,
          ATLAS_RUNTIME_MAX_JOBS: String(jobIds.length),
          ATLAS_RUNTIME_MAX_RUNTIME_MS: String(MAX_RUNTIME_MS),
        },
        command: `ATLAS_RUNTIME_ENRICHMENT_ONLY=true ATLAS_RUNTIME_JOB_IDS='${jobList}' ATLAS_RUNTIME_MAX_JOBS=${jobIds.length} ATLAS_RUNTIME_MAX_RUNTIME_MS=${MAX_RUNTIME_MS} npm run dev`,
        message: "미리보기만 생성했습니다. 이 요청은 job claim·Codex 호출·D1 쓰기를 수행하지 않습니다.",
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof RelationshipCandidateSelectionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "관계 후보 선택을 검증하지 못했습니다." },
      { status: 500 },
    );
  }
}
