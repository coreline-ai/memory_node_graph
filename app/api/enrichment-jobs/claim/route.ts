import { NextResponse } from "next/server";
import { requireAtlasRuntimeAccess } from "../../../lib/auth/runtime-access";
import { enrichmentApiError, readLimitedJson } from "../../../lib/http/enrichment-api";
import {
  EnrichmentRepositoryError,
  getEnrichmentJobRepository,
} from "../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireAtlasRuntimeAccess(request, { limitPerMinute: 60 });
  if ("response" in access) return access.response;
  try {
    const body = await readLimitedJson(request, 8_000) as {
      leaseDurationMs?: unknown;
      providerVersion?: unknown;
      jobIds?: unknown;
    };
    const leaseDurationMs = Math.min(300_000, Math.max(15_000, Number(body.leaseDurationMs) || 60_000));
    const providerVersion = typeof body.providerVersion === "string"
      ? body.providerVersion.trim().slice(0, 120) || undefined
      : undefined;
    const jobIds = body.jobIds === undefined
      ? undefined
      : (() => {
        if (!Array.isArray(body.jobIds)) {
          throw new EnrichmentRepositoryError("invalid_input", "jobIds는 문자열 배열이어야 합니다.");
        }
        const ids = [...new Set(body.jobIds.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
        if (!ids.length || ids.length > 25 || ids.some((id) => id.length > 200 || /[\r\n]/.test(id))) {
          throw new EnrichmentRepositoryError("invalid_input", "jobIds는 1~25개의 안전한 작업 ID여야 합니다.");
        }
        return ids;
      })();
    const repository = await getEnrichmentJobRepository();
    const job = await repository.claim({ runtimeId: access.runtimeId, leaseDurationMs, providerVersion, jobIds });
    return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
