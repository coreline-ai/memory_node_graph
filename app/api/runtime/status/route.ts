import { NextResponse } from "next/server";
import { requireAtlasRuntimeAccess } from "../../../lib/auth/runtime-access";
import { parseGitHubCapabilityReport } from "../../../lib/github/source-job-contracts";
import { asObject, enrichmentApiError, readLimitedJson } from "../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../lib/storage/enrichment-job-repository";
import { getGitHubSourceJobRepository } from "../../../lib/storage/github-source-job-repository";
import { getGraphAnswerJobRepository } from "../../../lib/storage/graph-answer-job-repository";
import {
  RUNTIME_RUN_MODES,
  RUNTIME_RUN_STOP_REASONS,
  CODEX_RUNTIME_STATES,
  type RuntimeRunTelemetry,
} from "../../../lib/llm/enrichment-contracts";

export const dynamic = "force-dynamic";

const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/;
const optionalInteger = (value: unknown, minimum: number, maximum: number) => {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
};

/**
 * Private status channel used only by the launcher-owned local OAuth runtime.
 * It replaces the old externally-started heartbeat/capability endpoints.
 */
export async function POST(request: Request) {
  const access = await requireAtlasRuntimeAccess(request, { limitPerMinute: 120 });
  if ("response" in access) return access.response;
  try {
    const body = asObject(await readLimitedJson(request, 12_000));
    // Accept the normal envelope and a direct capability report while tests
    // and in-flight local launchers transition to the unified status route.
    const githubPayload = body.github === undefined
      ? (body.capability === "github-source" ? body : null)
      : asObject(body.github);
    const github = githubPayload
      ? await (await getGitHubSourceJobRepository()).recordRuntimeCapability({
        runtimeId: access.runtimeId,
        ...parseGitHubCapabilityReport(githubPayload),
      })
      : undefined;

    const hasCodexStatus = !githubPayload && ("status" in body || "runtimeState" in body || "version" in body);
    if (!hasCodexStatus) {
      return NextResponse.json({ github }, { headers: { "cache-control": "no-store" } });
    }

    const status = body.status === "offline" ? "offline" : "online";
    const version = typeof body.version === "string" && versionPattern.test(body.version)
      ? body.version
      : "unknown";
    const currentJobId = typeof body.currentJobId === "string"
      ? body.currentJobId.slice(0, 160)
      : undefined;
    const runtimeState = typeof body.runtimeState === "string" && CODEX_RUNTIME_STATES.includes(
      body.runtimeState as (typeof CODEX_RUNTIME_STATES)[number],
    ) ? body.runtimeState as (typeof CODEX_RUNTIME_STATES)[number] : undefined;
    const runtimeMessage = typeof body.runtimeMessage === "string"
      ? body.runtimeMessage.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 500)
      : undefined;
    const run = asObject(body.run);
    const telemetry: RuntimeRunTelemetry = {
      runMode: typeof run.mode === "string" && RUNTIME_RUN_MODES.includes(
        run.mode as (typeof RUNTIME_RUN_MODES)[number],
      ) ? run.mode as RuntimeRunTelemetry["runMode"] : undefined,
      maxJobs: optionalInteger(run.maxJobs, 0, 100),
      maxRuntimeMs: optionalInteger(run.maxRuntimeMs, 1_000, 86_400_000),
      processedJobs: optionalInteger(run.processedJobs, 0, 100_000),
      succeededJobs: optionalInteger(run.succeededJobs, 0, 100_000),
      warningJobs: optionalInteger(run.warningJobs, 0, 100_000),
      failedJobs: optionalInteger(run.failedJobs, 0, 100_000),
      stopReason: typeof run.stopReason === "string" && RUNTIME_RUN_STOP_REASONS.includes(
        run.stopReason as (typeof RUNTIME_RUN_STOP_REASONS)[number],
      ) ? run.stopReason as RuntimeRunTelemetry["stopReason"] : undefined,
    };
    const repository = await getEnrichmentJobRepository();
    const runtime = await repository.recordRuntimeStatus({
      runtimeId: access.runtimeId,
      status,
      version,
      currentJobId,
      runtimeState,
      runtimeMessage,
      ...telemetry,
    });
    const [counts, answerCounts] = await Promise.all([
      repository.statusCounts(),
      (await getGraphAnswerJobRepository()).statusCounts(),
    ]);
    return NextResponse.json({
      runtime,
      github,
      queue: {
        queuedJobs: counts.queued + answerCounts.queued,
        activeJobs: counts.leased + counts.running + answerCounts.leased + answerCounts.running,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
