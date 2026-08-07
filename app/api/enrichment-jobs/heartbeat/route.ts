import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../lib/auth/connector-access";
import { asObject, enrichmentApiError, readLimitedJson } from "../../../lib/http/enrichment-api";
import { getEnrichmentJobRepository } from "../../../lib/storage/enrichment-job-repository";
import { getGraphAnswerJobRepository } from "../../../lib/storage/graph-answer-job-repository";
import {
  CONNECTOR_RUN_MODES,
  CONNECTOR_RUN_STOP_REASONS,
  type ConnectorRunTelemetry,
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

export async function POST(request: Request) {
  const access = await requireAtlasConnectorAccess(request, { limitPerMinute: 120 });
  if ("response" in access) return access.response;
  try {
    const body = asObject(await readLimitedJson(request, 4_000));
    const status = body.status === "offline" ? "offline" : "online";
    const version = typeof body.version === "string" && versionPattern.test(body.version)
      ? body.version
      : "unknown";
    const currentJobId = typeof body.currentJobId === "string"
      ? body.currentJobId.slice(0, 160)
      : undefined;
    const run = asObject(body.run);
    const telemetry: ConnectorRunTelemetry = {
      runMode: typeof run.mode === "string" && CONNECTOR_RUN_MODES.includes(
        run.mode as (typeof CONNECTOR_RUN_MODES)[number],
      ) ? run.mode as ConnectorRunTelemetry["runMode"] : undefined,
      maxJobs: optionalInteger(run.maxJobs, 0, 100),
      maxRuntimeMs: optionalInteger(run.maxRuntimeMs, 1_000, 86_400_000),
      processedJobs: optionalInteger(run.processedJobs, 0, 100_000),
      succeededJobs: optionalInteger(run.succeededJobs, 0, 100_000),
      warningJobs: optionalInteger(run.warningJobs, 0, 100_000),
      failedJobs: optionalInteger(run.failedJobs, 0, 100_000),
      stopReason: typeof run.stopReason === "string" && CONNECTOR_RUN_STOP_REASONS.includes(
        run.stopReason as (typeof CONNECTOR_RUN_STOP_REASONS)[number],
      ) ? run.stopReason as ConnectorRunTelemetry["stopReason"] : undefined,
    };
    const repository = await getEnrichmentJobRepository();
    const heartbeat = await repository.recordConnectorHeartbeat({
      connectorId: access.connectorId,
      status,
      version,
      currentJobId,
      ...telemetry,
    });
    const [counts, answerCounts] = await Promise.all([
      repository.statusCounts(),
      (await getGraphAnswerJobRepository()).statusCounts(),
    ]);
    return NextResponse.json({
      heartbeat,
      queue: {
        queuedJobs: counts.queued + answerCounts.queued,
        activeJobs: counts.leased + counts.running + answerCounts.leased + answerCounts.running,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return enrichmentApiError(error);
  }
}
