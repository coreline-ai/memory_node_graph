import type { EnrichmentJobRecord } from "../../app/lib/llm/enrichment-contracts.js";
import type {
  GraphAnswerErrorCode,
  GraphAnswerJobRecord,
} from "../../app/lib/llm/graph-answer-contracts.js";
import type { GitHubSourceJobRecord } from "../../app/lib/github/source-job-contracts.js";
import { CodexEngineError, CodexEnrichmentEngine } from "../codex/codex-engine.js";
import { IntegratedRuntimeClient, IntegratedRuntimeClientError } from "./client.js";
import type { IntegratedRuntimeConfig } from "./config.js";
import { GitHubSourceEngine, GitHubSourceEngineError } from "../github/github-source-engine.js";
import type {
  RuntimeRunOptions,
  RuntimeRunReceipt,
  RuntimeRunStopReason,
} from "./run-policy.js";

const sleep = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
});

const safeMessage = (error: unknown) => {
  if (
    error instanceof CodexEngineError
    || error instanceof IntegratedRuntimeClientError
    || error instanceof GitHubSourceEngineError
  ) return error.message;
  return error instanceof Error ? error.message.slice(0, 300) : "알 수 없는 오류";
};

export class IntegratedRuntimeRunner {
  private readonly client: Pick<IntegratedRuntimeClient, "claim" | "start" | "renewLease" | "submit" | "fail">
    & Partial<Pick<IntegratedRuntimeClient, "reportRuntimeStatus">>;
  private readonly sourceClient?: Pick<IntegratedRuntimeClient,
    | "reportGitHubRuntimeStatus"
    | "claimGitHubSource"
    | "startGitHubSource"
    | "renewGitHubSourceLease"
    | "submitGitHubSource"
    | "failGitHubSource"
  >;
  private readonly answerClient?: Pick<IntegratedRuntimeClient,
    | "claimGraphAnswer"
    | "startGraphAnswer"
    | "renewGraphAnswerLease"
    | "submitGraphAnswer"
    | "failGraphAnswer"
  >;
  private readonly engine: Pick<CodexEnrichmentEngine, "checkAuthentication" | "enrich">;
  private readonly answerEngine?: Pick<CodexEnrichmentEngine, "answerGraphQuery">;
  private readonly sourceEngine?: Pick<GitHubSourceEngine, "checkCapability" | "executeJob">;
  private stopping = false;
  private requestedStopReason: RuntimeRunStopReason | null = null;
  private codexAuthenticated = false;
  private runtimeAuthenticationState: "connected" | "login_required" | "reauth_required" = "connected";
  private readonly runtimeWasAuthenticated: boolean;
  private activeController: AbortController | null = null;
  private runController: AbortController | null = null;
  private activeJobId: string | undefined;

  constructor(
    private readonly config: IntegratedRuntimeConfig,
    dependencies: {
      client?: Pick<IntegratedRuntimeClient, "claim" | "start" | "renewLease" | "submit" | "fail">
        & Partial<Pick<IntegratedRuntimeClient,
          | "reportRuntimeStatus"
          | "reportGitHubRuntimeStatus"
          | "claimGitHubSource"
          | "startGitHubSource"
          | "renewGitHubSourceLease"
          | "submitGitHubSource"
          | "failGitHubSource"
          | "claimGraphAnswer"
          | "startGraphAnswer"
          | "renewGraphAnswerLease"
          | "submitGraphAnswer"
          | "failGraphAnswer"
        >>;
      engine?: Pick<CodexEnrichmentEngine, "checkAuthentication" | "enrich">
        & Partial<Pick<CodexEnrichmentEngine, "answerGraphQuery">>;
      sourceEngine?: Pick<GitHubSourceEngine, "checkCapability" | "executeJob">;
      enableGitHubSource?: boolean;
      runtimeWasAuthenticated?: boolean;
    } = {},
  ) {
    this.client = dependencies.client ?? new IntegratedRuntimeClient(config);
    this.engine = dependencies.engine ?? new CodexEnrichmentEngine(config);
    this.runtimeWasAuthenticated = Boolean(dependencies.runtimeWasAuthenticated);
    const candidate = this.client as typeof this.client & Partial<IntegratedRuntimeClient>;
    if (
      dependencies.enableGitHubSource !== false
      &&
      candidate.reportGitHubRuntimeStatus
      && candidate.claimGitHubSource
      && candidate.startGitHubSource
      && candidate.renewGitHubSourceLease
      && candidate.submitGitHubSource
      && candidate.failGitHubSource
    ) {
      this.sourceClient = candidate as typeof this.sourceClient;
      this.sourceEngine = dependencies.sourceEngine ?? new GitHubSourceEngine(config);
    }
    const engineCandidate = this.engine as typeof this.engine & Partial<CodexEnrichmentEngine>;
    if (
      candidate.claimGraphAnswer
      && candidate.startGraphAnswer
      && candidate.renewGraphAnswerLease
      && candidate.submitGraphAnswer
      && candidate.failGraphAnswer
      && engineCandidate.answerGraphQuery
    ) {
      this.answerClient = candidate as typeof this.answerClient;
      this.answerEngine = engineCandidate as typeof this.answerEngine;
    }
  }

  stop(reason: RuntimeRunStopReason = "signal") {
    this.stopping = true;
    this.requestedStopReason ??= reason;
    this.runController?.abort(reason);
    this.activeController?.abort(reason);
  }

  private async ensureCodexAuthentication() {
    if (this.codexAuthenticated) return;
    try {
      await this.engine.checkAuthentication();
      this.codexAuthenticated = true;
      this.runtimeAuthenticationState = "connected";
    } catch (error) {
      if (error instanceof CodexEngineError && error.code === "runtime_auth_required") {
        this.runtimeAuthenticationState = this.runtimeWasAuthenticated
          ? "reauth_required"
          : "login_required";
      }
      throw error;
    }
  }

  private async processEnrichment(job: EnrichmentJobRecord): Promise<"completed" | "warning" | "failed"> {
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
      console.info(`[atlas-runtime] running job=${job.id} attempt=${job.attemptCount}`);
      const result = await this.engine.enrich(job, controller.signal);
      if (leaseLost) throw new CodexEngineError("lease_expired", true, "작업 Lease를 잃었습니다.");
      const completed = await this.client.submit(job.id, result, controller.signal);
      console.info(
        `[atlas-runtime] ${completed.status} job=${job.id} relations=${result.relations.length}`
        + ` input_tokens=${result.usage?.inputTokens ?? 0} output_tokens=${result.usage?.outputTokens ?? 0}`,
      );
      return completed.status === "warning" ? "warning" : "completed";
    } catch (error) {
      const failure = error instanceof CodexEngineError
        ? error
        : new CodexEngineError("runtime_unavailable", true, safeMessage(error));
      console.warn(`[atlas-runtime] failed job=${job.id} code=${failure.code} message=${failure.message}`);
      if (!leaseLost) {
        await this.client.fail(job.id, {
          errorCode: failure.code,
          errorMessage: failure.message,
          retryable: failure.retryable,
        }).catch((submitError) => {
          console.warn(`[atlas-runtime] failure-report job=${job.id} message=${safeMessage(submitError)}`);
        });
      }
      return "failed";
    } finally {
      clearInterval(heartbeat);
      this.activeController = null;
      this.activeJobId = undefined;
    }
  }

  private async processGraphAnswer(job: GraphAnswerJobRecord): Promise<"completed" | "failed"> {
    if (!this.answerClient || !this.answerEngine) return "failed";
    const controller = new AbortController();
    this.activeController = controller;
    this.activeJobId = job.id;
    let leaseLost = false;
    const heartbeatMs = Math.max(5_000, Math.floor(this.config.leaseDurationMs / 3));
    const heartbeat = setInterval(() => {
      void this.answerClient?.renewGraphAnswerLease(job.id, controller.signal).catch(() => {
        leaseLost = true;
        controller.abort("lease_lost");
      });
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      await this.answerClient.startGraphAnswer(job.id, controller.signal);
      console.info(`[atlas-runtime] running graph-answer job=${job.id} attempt=${job.attemptCount}`);
      const result = await this.answerEngine.answerGraphQuery(job, controller.signal);
      if (leaseLost) throw new CodexEngineError("lease_expired", true, "그래프 답변 작업 Lease를 잃었습니다.");
      const completed = await this.answerClient.submitGraphAnswer(job.id, result, controller.signal);
      console.info(
        `[atlas-runtime] ${completed.status} graph-answer job=${job.id}`
        + ` claims=${result.claims.length} citations=${result.citationIds.length}`
        + ` input_tokens=${result.usage?.inputTokens ?? 0} output_tokens=${result.usage?.outputTokens ?? 0}`,
      );
      return "completed";
    } catch (error) {
      const failure = error instanceof CodexEngineError
        ? error
        : new CodexEngineError("runtime_unavailable", true, safeMessage(error));
      console.warn(`[atlas-runtime] failed graph-answer job=${job.id} code=${failure.code} message=${failure.message}`);
      if (!leaseLost) {
        await this.answerClient.failGraphAnswer(job.id, {
          errorCode: failure.code as GraphAnswerErrorCode,
          errorMessage: failure.message,
          retryable: failure.retryable,
        }).catch((submitError) => {
          console.warn(`[atlas-runtime] failure-report graph-answer job=${job.id} message=${safeMessage(submitError)}`);
        });
      }
      return "failed";
    } finally {
      clearInterval(heartbeat);
      this.activeController = null;
      this.activeJobId = undefined;
    }
  }

  private async processGitHubSource(job: GitHubSourceJobRecord): Promise<"completed" | "failed"> {
    if (!this.sourceClient || !this.sourceEngine) return "failed";
    const controller = new AbortController();
    this.activeController = controller;
    this.activeJobId = job.id;
    let leaseLost = false;
    const heartbeatMs = Math.max(5_000, Math.floor(this.config.leaseDurationMs / 3));
    const heartbeat = setInterval(() => {
      void this.sourceClient?.renewGitHubSourceLease(job.id, controller.signal).catch(() => {
        leaseLost = true;
        controller.abort("lease_lost");
      });
    }, heartbeatMs);
    heartbeat.unref?.();

    try {
      await this.sourceClient.startGitHubSource(job.id, controller.signal);
      console.info(`[atlas-runtime] running github-source job=${job.id} kind=${job.kind} attempt=${job.attemptCount}`);
      const result = await this.sourceEngine.executeJob(job, controller.signal);
      if (leaseLost) {
        throw new GitHubSourceEngineError("lease_expired", true, "GitHub source 작업 Lease를 잃었습니다.");
      }
      await this.sourceClient.reportGitHubRuntimeStatus(result.capability, controller.signal);
      const completed = await this.sourceClient.submitGitHubSource(job.id, result, controller.signal);
      console.info(
        `[atlas-runtime] ${completed.status} github-source job=${job.id}`
        + ` discovered=${result.summary.discoveredCount} selected=${result.summary.selectedCount}`
        + ` changed=${result.summary.changedCount} unchanged=${result.summary.unchangedCount}`,
      );
      return "completed";
    } catch (error) {
      const failure = error instanceof GitHubSourceEngineError
        ? error
        : new GitHubSourceEngineError("runtime_unavailable", true, safeMessage(error));
      console.warn(`[atlas-runtime] failed github-source job=${job.id} code=${failure.code} message=${failure.message}`);
      if (!leaseLost) {
        const capability = await this.sourceEngine.checkCapability().catch(() => null);
        if (capability) await this.sourceClient.reportGitHubRuntimeStatus(capability).catch(() => undefined);
        await this.sourceClient.failGitHubSource(job.id, {
          errorCode: failure.code,
          errorMessage: failure.message,
          retryable: failure.retryable,
        }).catch((submitError) => {
          console.warn(`[atlas-runtime] failure-report github-source job=${job.id} message=${safeMessage(submitError)}`);
        });
      }
      return "failed";
    } finally {
      clearInterval(heartbeat);
      this.activeController = null;
      this.activeJobId = undefined;
    }
  }

  async run(options: RuntimeRunOptions = {}): Promise<RuntimeRunReceipt> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const mode: RuntimeRunReceipt["mode"] = options.once || options.maxJobs !== undefined || options.maxRuntimeMs !== undefined
      ? "bounded"
      : "continuous";
    const counters = { claimed: 0, succeeded: 0, warning: 0, failed: 0 };
    let initialQueuedJobs: number | undefined;
    let remainingQueuedJobs: number | undefined;
    let stopReason: RuntimeRunStopReason | null = null;
    let fatalError: unknown;
    this.runController = new AbortController();

    const telemetry = (reason?: RuntimeRunStopReason) => ({
      runMode: mode,
      maxJobs: options.maxJobs,
      maxRuntimeMs: options.maxRuntimeMs,
      processedJobs: counters.claimed,
      succeededJobs: counters.succeeded,
      warningJobs: counters.warning,
      failedJobs: counters.failed,
      stopReason: reason,
    });
    const heartbeatReport = async (status: "online" | "offline", reason?: RuntimeRunStopReason) => {
      const integratedRuntime = this.config.version.startsWith("atlas-integrated-codex-runtime-");
      const runtimeState = status === "online" && this.activeJobId
        ? "running"
        : status === "online"
          ? this.runtimeAuthenticationState
          : reason === "fatal"
            ? "failed"
            : this.runtimeAuthenticationState;
      const response = await this.client.reportRuntimeStatus?.(
        status,
        this.activeJobId,
        telemetry(reason),
        integratedRuntime ? {
          state: runtimeState,
          message: status === "online"
            ? this.activeJobId
              ? "통합 작업 런타임이 작업을 처리하고 있습니다."
              : this.runtimeAuthenticationState === "login_required"
                ? "Codex OAuth 로그인이 필요합니다. GitHub 문서 동기화는 독립적으로 동작합니다."
                : this.runtimeAuthenticationState === "reauth_required"
                  ? "Codex OAuth 재로그인이 필요합니다. GitHub 문서 동기화는 독립적으로 동작합니다."
                  : "Codex OAuth 세션이 연결되어 있습니다."
            : "통합 Codex 작업 런타임이 중지되었습니다.",
        } : undefined,
      );
      if (response && "queuedJobs" in response && typeof response.queuedJobs === "number") {
        remainingQueuedJobs = response.queuedJobs;
        initialQueuedJobs ??= response.queuedJobs;
      }
      return response;
    };

    await heartbeatReport("online");
    console.info(
      `[atlas-runtime] run mode=${mode} max_jobs=${options.maxJobs ?? "unlimited"}`
      + ` max_runtime_ms=${options.maxRuntimeMs ?? "unlimited"}`
      + ` enrichment_only=${Boolean(options.enrichmentOnly)}`
      + ` queued=${initialQueuedJobs ?? "unknown"}`,
    );
    if (options.maxJobs === 0) {
      stopReason = "dry_run";
    }
    if (!options.enrichmentOnly && this.sourceClient && this.sourceEngine) {
      const capability = await this.sourceEngine.checkCapability();
      await this.sourceClient.reportGitHubRuntimeStatus(capability);
      console.info(`[atlas-runtime] github-source status=${capability.status} account=${capability.accountLogin ?? "none"}`);
    }
    console.info(`[atlas-runtime] ready id=${this.config.runtimeId} base=${this.config.baseUrl}`);
    let failures = 0;
    const heartbeat = setInterval(() => {
      void heartbeatReport("online").catch((error) => {
        console.warn(`[atlas-runtime] heartbeat-error message=${safeMessage(error)}`);
      });
      if (!options.enrichmentOnly && this.sourceClient && this.sourceEngine) {
        void this.sourceEngine.checkCapability()
          .then((capability) => this.sourceClient?.reportGitHubRuntimeStatus(capability))
          .catch((error) => {
            console.warn(`[atlas-runtime] github-capability-error message=${safeMessage(error)}`);
          });
      }
    }, this.config.statusIntervalMs);
    heartbeat.unref?.();
    const deadline = options.maxRuntimeMs === undefined ? null : setTimeout(() => {
      this.stop("runtime_limit");
    }, options.maxRuntimeMs);
    deadline?.unref?.();
    try {
      while (!this.stopping && !stopReason) {
        try {
          const sourceJob = options.enrichmentOnly
            ? null
            : await this.sourceClient?.claimGitHubSource();
          if (sourceJob) {
            counters.claimed += 1;
            const outcome = await this.processGitHubSource(sourceJob);
            if (outcome === "completed") counters.succeeded += 1;
            else counters.failed += 1;
          }
          const answerJob = sourceJob || options.enrichmentOnly
            ? null
            : await this.answerClient?.claimGraphAnswer();
          if (answerJob) {
            await this.ensureCodexAuthentication();
            counters.claimed += 1;
            const outcome = await this.processGraphAnswer(answerJob);
            if (outcome === "completed") counters.succeeded += 1;
            else counters.failed += 1;
          }
          if (!sourceJob && !answerJob) await this.ensureCodexAuthentication();
          const job = sourceJob || answerJob ? null : await this.client.claim();
          failures = 0;
          if (job) {
            counters.claimed += 1;
            const outcome = await this.processEnrichment(job);
            if (outcome === "completed") counters.succeeded += 1;
            else if (outcome === "warning") counters.warning += 1;
            else counters.failed += 1;
          }
          if (sourceJob || answerJob || job) {
            if (this.stopping) continue;
            if (options.once) stopReason = "once";
            else if (options.maxJobs !== undefined && counters.claimed >= options.maxJobs) {
              stopReason = "job_limit";
            }
            continue;
          }
          if (options.stopWhenIdle || options.once) {
            stopReason = "idle";
            continue;
          }
          await sleep(this.config.pollIntervalMs, this.runController.signal);
        } catch (error) {
          if (this.stopping) break;
          if (error instanceof CodexEngineError && error.code === "runtime_auth_required") {
            await heartbeatReport("online").catch(() => undefined);
          }
          failures += 1;
          const delay = Math.min(
            this.config.maximumBackoffMs,
            this.config.pollIntervalMs * 2 ** Math.min(6, failures - 1),
          );
          console.warn(`[atlas-runtime] poll-error message=${safeMessage(error)} retry_ms=${delay}`);
          if (mode === "bounded") {
            fatalError = error;
            stopReason = "fatal";
            break;
          }
          await sleep(delay, this.runController.signal);
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (deadline) clearTimeout(deadline);
      stopReason ??= this.requestedStopReason ?? (this.stopping ? "signal" : "idle");
      await heartbeatReport("offline", stopReason).catch(() => undefined);
      this.runController = null;
    }

    const completedAtMs = Date.now();
    const receipt: RuntimeRunReceipt = {
      mode,
      startedAt,
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs: Math.max(0, completedAtMs - startedAtMs),
      maxJobs: options.maxJobs,
      maxRuntimeMs: options.maxRuntimeMs,
      enrichmentOnly: Boolean(options.enrichmentOnly),
      claimedJobs: counters.claimed,
      succeededJobs: counters.succeeded,
      warningJobs: counters.warning,
      failedJobs: counters.failed,
      initialQueuedJobs,
      remainingQueuedJobs,
      stopReason,
    };
    console.info(
      `[atlas-runtime] stopped reason=${receipt.stopReason} processed=${receipt.claimedJobs}`
      + ` success=${receipt.succeededJobs} warning=${receipt.warningJobs}`
      + ` failed=${receipt.failedJobs} remaining=${receipt.remainingQueuedJobs ?? "unknown"}`,
    );
    if (fatalError) throw fatalError;
    return receipt;
  }
}
