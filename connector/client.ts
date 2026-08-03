import type {
  EnrichmentErrorCode,
  EnrichmentJobRecord,
  EnrichmentResult,
} from "../app/lib/llm/enrichment-contracts.js";
import type { ConnectorConfig } from "./config.js";

export class ConnectorClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectorClientError";
  }
}

export class ConnectorClient {
  constructor(private readonly config: ConnectorConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("x-atlas-connector-id", this.config.connectorId);
    if (this.config.token) headers.set("authorization", `Bearer ${this.config.token}`);
    const response = await fetch(`${this.config.baseUrl}${path}`, { ...init, headers });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      throw new ConnectorClientError(
        response.status,
        String(payload.code ?? "connector_api_error"),
        String(payload.error ?? `Connector API 요청 실패 (${response.status})`),
      );
    }
    return payload as T;
  }

  async claim(signal?: AbortSignal) {
    const payload = await this.request<{ job: EnrichmentJobRecord | null }>(
      "/api/enrichment-jobs/claim",
      {
        method: "POST",
        body: JSON.stringify({ leaseDurationMs: this.config.leaseDurationMs }),
        signal,
      },
    );
    return payload.job;
  }

  async heartbeat(
    status: "online" | "offline",
    currentJobId?: string,
    signal?: AbortSignal,
  ) {
    return (await this.request<{ heartbeat: { lastSeenAt: string } }>(
      "/api/enrichment-jobs/heartbeat",
      {
        method: "POST",
        body: JSON.stringify({ status, currentJobId, version: this.config.version }),
        signal,
      },
    )).heartbeat;
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
}
