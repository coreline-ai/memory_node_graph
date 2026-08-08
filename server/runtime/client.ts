import type {
  RuntimeStatusRecord,
  RuntimeRunTelemetry,
  EnrichmentErrorCode,
  EnrichmentJobRecord,
  EnrichmentResult,
} from "../../app/lib/llm/enrichment-contracts.js";
import type {
  GitHubRuntimeCapabilityRecord,
  GitHubSourceErrorCode,
  GitHubSourceJobRecord,
  GitHubSourceJobResult,
} from "../../app/lib/github/source-job-contracts.js";
import type { GitHubApplySubmission } from "../../app/lib/github/apply-contracts.js";
import type {
  GraphAnswerErrorCode,
  GraphAnswerJobRecord,
  GraphAnswerResult,
} from "../../app/lib/llm/graph-answer-contracts.js";
import {
  createGitHubApplyStageChunks,
  GITHUB_APPLY_CHUNK_MAX_FILES,
  GITHUB_APPLY_INLINE_MAX_BYTES,
} from "../../app/lib/github/apply-stage-contracts.js";
import type { IntegratedRuntimeConfig } from "./config.js";

export class IntegratedRuntimeClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IntegratedRuntimeClientError";
  }
}

export class IntegratedRuntimeClient {
  constructor(private readonly config: IntegratedRuntimeConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("x-atlas-runtime-id", this.config.runtimeId);
    if (this.config.internalRuntimeSecret) {
      headers.set("x-atlas-internal-runtime-secret", this.config.internalRuntimeSecret);
    }
    const response = await fetch(`${this.config.baseUrl}${path}`, { ...init, headers });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new IntegratedRuntimeClientError(
        response.status,
        String(payload.code ?? "runtime_api_error"),
        String(payload.error ?? `통합 런타임 API 요청 실패 (${response.status})`),
      );
    }
    return payload as T;
  }

  async claim(signal?: AbortSignal) {
    const payload = await this.request<{ job: EnrichmentJobRecord | null }>(
      "/api/enrichment-jobs/claim",
      {
        method: "POST",
        body: JSON.stringify({
          leaseDurationMs: this.config.leaseDurationMs,
          providerVersion: this.config.providerVersion,
        }),
        signal,
      },
    );
    return payload.job;
  }

  async reportRuntimeStatus(
    status: "online" | "offline",
    currentJobId?: string,
    run?: RuntimeRunTelemetry,
    runtime?: {
      state: RuntimeStatusRecord["runtimeState"];
      message?: string;
    },
    signal?: AbortSignal,
  ) {
    const runPayload = run ? {
      mode: run.runMode,
      maxJobs: run.maxJobs,
      maxRuntimeMs: run.maxRuntimeMs,
      processedJobs: run.processedJobs,
      succeededJobs: run.succeededJobs,
      warningJobs: run.warningJobs,
      failedJobs: run.failedJobs,
      stopReason: run.stopReason,
    } : undefined;
    const payload = await this.request<{
      runtime: RuntimeStatusRecord;
      queue: { queuedJobs: number; activeJobs: number };
    }>(
      "/api/runtime/status",
      {
        method: "POST",
        body: JSON.stringify({
          status,
          currentJobId,
          version: this.config.version,
          runtimeState: runtime?.state,
          runtimeMessage: runtime?.message,
          run: runPayload,
        }),
        signal,
      },
    );
    return { ...payload.runtime, ...payload.queue };
  }

  async start(jobId: string, signal?: AbortSignal) {
    return (await this.request<{ job: EnrichmentJobRecord }>(
      `/api/enrichment-jobs/${encodeURIComponent(jobId)}/start`,
      { method: "POST", body: "{}", signal },
    )).job;
  }

  async renewLease(jobId: string, signal?: AbortSignal) {
    return (await this.request<{ job: EnrichmentJobRecord }>(
      `/api/enrichment-jobs/${encodeURIComponent(jobId)}/lease`,
      {
        method: "POST",
        body: JSON.stringify({ leaseDurationMs: this.config.leaseDurationMs }),
        signal,
      },
    )).job;
  }

  async submit(jobId: string, result: EnrichmentResult, signal?: AbortSignal) {
    return (await this.request<{ job: EnrichmentJobRecord }>(
      `/api/enrichment-jobs/${encodeURIComponent(jobId)}/result`,
      { method: "POST", body: JSON.stringify(result), signal },
    )).job;
  }

  async fail(
    jobId: string,
    failure: {
      errorCode: EnrichmentErrorCode;
      errorMessage: string;
      retryable: boolean;
    },
    signal?: AbortSignal,
  ) {
    return (await this.request<{ job: EnrichmentJobRecord }>(
      `/api/enrichment-jobs/${encodeURIComponent(jobId)}/fail`,
      { method: "POST", body: JSON.stringify(failure), signal },
    )).job;
  }

  async claimGraphAnswer(signal?: AbortSignal) {
    const payload = await this.request<{ job: GraphAnswerJobRecord | null }>(
      "/api/graph/query-jobs/claim",
      {
        method: "POST",
        body: JSON.stringify({ leaseDurationMs: this.config.leaseDurationMs }),
        signal,
      },
    );
    return payload.job;
  }

  async startGraphAnswer(jobId: string, signal?: AbortSignal) {
    return (await this.request<{ job: GraphAnswerJobRecord }>(
      `/api/graph/query-jobs/${encodeURIComponent(jobId)}/start`,
      { method: "POST", body: "{}", signal },
    )).job;
  }

  async renewGraphAnswerLease(jobId: string, signal?: AbortSignal) {
    return (await this.request<{ job: GraphAnswerJobRecord }>(
      `/api/graph/query-jobs/${encodeURIComponent(jobId)}/lease`,
      {
        method: "POST",
        body: JSON.stringify({ leaseDurationMs: this.config.leaseDurationMs }),
        signal,
      },
    )).job;
  }

  async submitGraphAnswer(jobId: string, result: GraphAnswerResult, signal?: AbortSignal) {
    return (await this.request<{ job: GraphAnswerJobRecord }>(
      `/api/graph/query-jobs/${encodeURIComponent(jobId)}/result`,
      { method: "POST", body: JSON.stringify(result), signal },
    )).job;
  }

  async failGraphAnswer(
    jobId: string,
    failure: {
      errorCode: GraphAnswerErrorCode;
      errorMessage: string;
      retryable: boolean;
    },
    signal?: AbortSignal,
  ) {
    return (await this.request<{ job: GraphAnswerJobRecord }>(
      `/api/graph/query-jobs/${encodeURIComponent(jobId)}/fail`,
      { method: "POST", body: JSON.stringify(failure), signal },
    )).job;
  }

  async reportGitHubRuntimeStatus(
    report: Omit<GitHubRuntimeCapabilityRecord, "runtimeId" | "lastSeenAt">,
    signal?: AbortSignal,
  ) {
    return (await this.request<{ github: GitHubRuntimeCapabilityRecord }>(
      "/api/runtime/status",
      { method: "POST", body: JSON.stringify({ github: report }), signal },
    )).github;
  }

  async claimGitHubSource(signal?: AbortSignal) {
    const payload = await this.request<{ job: GitHubSourceJobRecord | null }>(
      "/api/github/source-jobs/claim",
      {
        method: "POST",
        body: JSON.stringify({
          leaseDurationMs: this.config.leaseDurationMs,
          runtimeVersion: this.config.githubRuntimeVersion,
        }),
        signal,
      },
    );
    return payload.job;
  }

  async startGitHubSource(jobId: string, signal?: AbortSignal) {
    return (await this.request<{ job: GitHubSourceJobRecord }>(
      `/api/github/source-jobs/${encodeURIComponent(jobId)}/start`,
      { method: "POST", body: "{}", signal },
    )).job;
  }

  async renewGitHubSourceLease(jobId: string, signal?: AbortSignal) {
    return (await this.request<{ job: GitHubSourceJobRecord }>(
      `/api/github/source-jobs/${encodeURIComponent(jobId)}/lease`,
      {
        method: "POST",
        body: JSON.stringify({ leaseDurationMs: this.config.leaseDurationMs }),
        signal,
      },
    )).job;
  }

  async submitGitHubSource(
    jobId: string,
    result: GitHubSourceJobResult | GitHubApplySubmission,
    signal?: AbortSignal,
  ) {
    if (
      result.kind === "apply"
      && "applyPayload" in result
      && result.applyPayload.documents.length
      && (
        result.applyPayload.documents.length > GITHUB_APPLY_CHUNK_MAX_FILES
        || new TextEncoder().encode(JSON.stringify(result)).byteLength > GITHUB_APPLY_INLINE_MAX_BYTES
      )
    ) {
      const staged = await createGitHubApplyStageChunks(jobId, result.applyPayload.documents);
      for (const chunk of staged.chunks) {
        const uploaded = await this.request<{
          stage: { chunkIndex: number; checksum: string; receivedChunks: number; totalChunks: number };
        }>(`/api/github/source-jobs/${encodeURIComponent(jobId)}/stage`, {
          method: "POST",
          body: JSON.stringify(chunk),
          signal,
        });
        if (
          uploaded.stage.chunkIndex !== chunk.chunkIndex
          || uploaded.stage.checksum !== chunk.checksum
          || uploaded.stage.totalChunks !== chunk.totalChunks
        ) throw new IntegratedRuntimeClientError(502, "invalid_result", "Apply stage chunk 확인 응답이 일치하지 않습니다.");
      }
      const stagedResult = {
        ...result,
        applyPayload: {
          preview: result.applyPayload.preview,
          reusedDocuments: result.applyPayload.reusedDocuments,
          downloadedAt: result.applyPayload.downloadedAt,
          stage: staged.stage,
        },
      };
      return (await this.request<{ job: GitHubSourceJobRecord }>(
        `/api/github/source-jobs/${encodeURIComponent(jobId)}/result`,
        { method: "POST", body: JSON.stringify(stagedResult), signal },
      )).job;
    }
    return (await this.request<{ job: GitHubSourceJobRecord }>(
      `/api/github/source-jobs/${encodeURIComponent(jobId)}/result`,
      { method: "POST", body: JSON.stringify(result), signal },
    )).job;
  }

  async failGitHubSource(
    jobId: string,
    failure: {
      errorCode: GitHubSourceErrorCode;
      errorMessage: string;
      retryable: boolean;
    },
    signal?: AbortSignal,
  ) {
    return (await this.request<{ job: GitHubSourceJobRecord }>(
      `/api/github/source-jobs/${encodeURIComponent(jobId)}/fail`,
      { method: "POST", body: JSON.stringify(failure), signal },
    )).job;
  }
}
