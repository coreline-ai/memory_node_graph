import type { EnrichmentJobRecord } from "../app/lib/llm/enrichment-contracts.js";
import { CodexEngineError, CodexEnrichmentEngine } from "./codex-engine.js";
import { ConnectorClient, ConnectorClientError } from "./client.js";
import type { ConnectorConfig } from "./config.js";

const sleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, milliseconds);
  timeout.unref?.();
  signal?.addEventListener("abort", () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
});

const safeMessage = (error: unknown) => {
  if (error instanceof CodexEngineError || error instanceof ConnectorClientError) return error.message;
  return error instanceof Error ? error.message.slice(0, 300) : "알 수 없는 오류";
};

export class ConnectorRunner {
  private readonly client: Pick<ConnectorClient, "claim" | "start" | "renewLease" | "submit" | "fail">
    & Partial<Pick<ConnectorClient, "heartbeat">>;
  private readonly engine: Pick<CodexEnrichmentEngine, "checkAuthentication" | "enrich">;
  private stopping = false;
  private activeController: AbortController | null = null;
  private activeJobId: string | undefined;

  constructor(
    private readonly config: ConnectorConfig,
    dependencies: {
      client?: Pick<ConnectorClient, "claim" | "start" | "renewLease" | "submit" | "fail">
        & Partial<Pick<ConnectorClient, "heartbeat">>;
      engine?: Pick<CodexEnrichmentEngine, "checkAuthentication" | "enrich">;
    } = {},
  ) {
    this.client = dependencies.client ?? new ConnectorClient(config);
    this.engine = dependencies.engine ?? new CodexEnrichmentEngine(config);
  }

  stop() {
    this.stopping = true;
    this.activeController?.abort("connector_shutdown");
  }

  private async process(job: EnrichmentJobRecord) {
    const controller = new AbortController();
    this.activeController = controller;
    this.activeJobId = job.id;
    let leaseLost = false;
    const heartbeatMs = Math.max(5_000, Math.floor(this.config.leaseDurationMs / 3));
    const heartbeat = setInterval(() => {
      void this.client.renewLease(job.id, controller.signal).catch(() => {
        leaseLost = true;
        controller.abort("lease_lost");
      });
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      await this.client.start(job.id, controller.signal);
      console.info(`[atlas-connector] running job=${job.id} attempt=${job.attemptCount}`);
      const result = await this.engine.enrich(job, controller.signal);
      if (leaseLost) throw new CodexEngineError("lease_expired", true, "작업 Lease를 잃었습니다.");
      const completed = await this.client.submit(job.id, result, controller.signal);
      console.info(
        `[atlas-connector] ${completed.status} job=${job.id} relations=${result.relations.length}`
        + ` input_tokens=${result.usage?.inputTokens ?? 0} output_tokens=${result.usage?.outputTokens ?? 0}`,
      );
    } catch (error) {
      const failure = error instanceof CodexEngineError
        ? error
        : new CodexEngineError("connector_unavailable", true, safeMessage(error));
      console.warn(`[atlas-connector] failed job=${job.id} code=${failure.code} message=${failure.message}`);
      if (!leaseLost) {
        await this.client.fail(job.id, {
          errorCode: failure.code,
          errorMessage: failure.message,
          retryable: failure.retryable,
        }).catch((submitError) => {
          console.warn(`[atlas-connector] failure-report job=${job.id} message=${safeMessage(submitError)}`);
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.activeController = null;
      this.activeJobId = undefined;
    }
  }

  async run(options: { once?: boolean } = {}) {
    await this.engine.checkAuthentication();
    await this.client.heartbeat?.("online");
    console.info(`[atlas-connector] ready id=${this.config.connectorId} base=${this.config.baseUrl}`);
    let failures = 0;
    const heartbeat = setInterval(() => {
      void this.client.heartbeat?.("online", this.activeJobId).catch((error) => {
        console.warn(`[atlas-connector] heartbeat-error message=${safeMessage(error)}`);
      });
    }, this.config.heartbeatIntervalMs);
    heartbeat.unref?.();
    try {
      while (!this.stopping) {
        try {
          const job = await this.client.claim();
          failures = 0;
          if (job) await this.process(job);
          if (options.once) return;
          if (!job) await sleep(this.config.pollIntervalMs);
        } catch (error) {
          failures += 1;
          const delay = Math.min(
            this.config.maximumBackoffMs,
            this.config.pollIntervalMs * 2 ** Math.min(6, failures - 1),
          );
          console.warn(`[atlas-connector] poll-error message=${safeMessage(error)} retry_ms=${delay}`);
          if (options.once) throw error;
          await sleep(delay);
        }
      }
    } finally {
      clearInterval(heartbeat);
      await this.client.heartbeat?.("offline").catch(() => undefined);
      console.info("[atlas-connector] stopped");
    }
  }
}
