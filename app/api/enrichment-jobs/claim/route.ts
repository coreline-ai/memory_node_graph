import { NextResponse } from "next/server";
import { requireAtlasRuntimeAccess } from "../../../lib/auth/runtime-access";
import { enrichmentApiError, readLimitedJson } from "../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../lib/storage/enrichment-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requireAtlasRuntimeAccess(request, { limitPerMinute: 60 });
  if ("response" in access) return access.response;
  try {
    const body = await readLimitedJson(request, 8_000) as {
      leaseDurationMs?: unknown;
      providerVersion?: unknown;
    };
    const leaseDurationMs = Math.min(300_000, Math.max(15_000, Number(body.leaseDurationMs) || 60_000));
    const providerVersion = typeof body.providerVersion === "string"
      ? body.providerVersion.trim().slice(0, 120) || undefined
      : undefined;
    const repository = await getEnrichmentJobRepository();
    const job = await repository.claim({ runtimeId: access.runtimeId, leaseDurationMs, providerVersion });
    return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
