import { NextResponse } from "next/server";
import { requireAtlasConnectorAccess } from "../../../../../lib/auth/connector-access";
import { validateGitHubApplySubmission } from "../../../../../lib/github/apply-contracts";
import { hydrateGitHubApplyStageSubmission } from "../../../../../lib/github/apply-stage-contracts";
import { applySingleGitHubRepository } from "../../../../../lib/github/apply-service";
import type { GitHubSourceJobResult } from "../../../../../lib/github/source-job-contracts";
import { githubSourceApiError } from "../../../../../lib/http/github-source-api";
import { readLimitedJson } from "../../../../../lib/http/enrichment-api";
import {
  getGitHubSourceJobRepository,
  GitHubSourceRepositoryError,
} from "../../../../../lib/storage/github-source-job-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const access = await requireAtlasConnectorAccess(request, { limitPerMinute: 120 });
  if ("response" in access) return access.response;
  try {
    const { jobId } = await context.params;
    const repository = await getGitHubSourceJobRepository();
    const current = await repository.get(jobId);
    if (!current) throw new GitHubSourceRepositoryError("invalid_input", "GitHub source 작업을 찾을 수 없습니다.");
    if (
      !["leased", "running"].includes(current.status)
      || current.leaseOwner !== access.connectorId
      || !current.leaseExpiresAt
      || Date.parse(current.leaseExpiresAt) <= Date.now()
    ) throw new GitHubSourceRepositoryError("lease_conflict", "현재 Connector가 소유한 유효 Lease가 아닙니다.");
    const submitted = await readLimitedJson(request, 12 * 1024 * 1024);
    let result: unknown = submitted;
    if (current.kind === "apply") {
      const storedChunks = await repository.listApplyStageChunks(current.id);
      const applySubmission = await (async () => {
        try {
          const hydrated = await hydrateGitHubApplyStageSubmission(
            submitted,
            current.id,
            storedChunks,
          );
          return await validateGitHubApplySubmission(hydrated.submission, current);
        } catch (error) {
          if (storedChunks.length) {
            await repository.deleteApplyStageChunks(current.id).catch(() => undefined);
          }
          throw error;
        }
      })();
      const receipt = await applySingleGitHubRepository({
        jobId: current.id,
        payload: applySubmission.applyPayload,
      });
      result = {
        jobId: current.id,
        idempotencyKey: current.idempotencyKey,
        kind: "apply",
        status: "completed",
        capability: applySubmission.capability,
        summary: {
          discoveredCount: 1,
          selectedCount: 1,
          changedCount: receipt.createdCount + receipt.updatedCount,
          unchangedCount: receipt.unchangedCount,
          deletedCount: receipt.deletedCount,
          failedCount: 0,
        },
        apply: receipt,
      } satisfies GitHubSourceJobResult;
    }
    const job = await repository.complete({
      jobId,
      connectorId: access.connectorId,
      result,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return githubSourceApiError(error);
  }
}
