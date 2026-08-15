import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CodexRuntimeState } from "../../app/lib/llm/enrichment-contracts.js";
import type { CodexRuntimeStatus } from "../../app/lib/llm/codex-runtime-status.js";
import { IntegratedRuntimeClient } from "./client.js";
import { IntegratedRuntimeRunner } from "./runner.js";
import { CodexEngineError, CodexEnrichmentEngine } from "../codex/codex-engine.js";
import { assertRuntimeProductionConfiguration, codexRuntimeConfig } from "./config.js";
import { acquireRuntimeSingletonLock, RuntimeAlreadyRunningError } from "./singleton-lock.js";
import { parseRuntimeRunOptions } from "./run-policy.js";

const lockPath = process.env.ATLAS_RUNTIME_LOCK_PATH?.trim()
  || join(tmpdir(), `${codexRuntimeConfig.runtimeId}.lock`);
const client = new IntegratedRuntimeClient(codexRuntimeConfig);
const engine = new CodexEnrichmentEngine(codexRuntimeConfig);
let stopping = false;
let runner: IntegratedRuntimeRunner | null = null;

const safeMessage = (error: unknown) => error instanceof Error
  ? error.message.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 300)
  : "Codex OAuth 상태를 확인하지 못했습니다.";

async function previousRuntimeStatus(): Promise<CodexRuntimeStatus | null> {
  try {
    const response = await fetch(`${codexRuntimeConfig.baseUrl}/api/runtime/codex/status`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { runtime?: CodexRuntimeStatus };
    return payload.runtime ?? null;
  } catch {
    return null;
  }
}

async function reportUnavailable(state: CodexRuntimeState, message: string) {
  await client.reportRuntimeStatus("offline", undefined, { stopReason: "fatal" }, { state, message });
}

async function runIntegrated(runtimeWasAuthenticated: boolean) {
  runner = new IntegratedRuntimeRunner(codexRuntimeConfig, {
    client,
    engine,
    enableGitHubSource: true,
    runtimeWasAuthenticated,
  });
  return runner.run(parseRuntimeRunOptions(process.argv.slice(2)));
}

async function main() {
  assertRuntimeProductionConfiguration();
  if (!codexRuntimeConfig.internalRuntimeSecret && process.env.NODE_ENV === "production") {
    throw new Error("통합 런타임 IPC 보안 값이 생성되지 않았습니다. 통합 실행기로 시작하세요.");
  }
  const release = await acquireRuntimeSingletonLock(lockPath);
  try {
    const previous = await previousRuntimeStatus();
    try {
      console.info(`[atlas-runtime] github=integrated codex=oauth id=${codexRuntimeConfig.runtimeId}`);
      await runIntegrated(Boolean(previous?.authenticated));
    } catch (error) {
      if (stopping) return;
      const authFailure = error instanceof CodexEngineError && error.code === "runtime_auth_required";
      const state: CodexRuntimeState = authFailure
        ? previous?.authenticated ? "reauth_required" : "login_required"
        : "failed";
      const message = authFailure
        ? state === "reauth_required" ? "Codex OAuth 재로그인이 필요합니다." : "Codex OAuth 로그인이 필요합니다."
        : safeMessage(error);
      await reportUnavailable(state, message).catch(() => undefined);
      throw error;
    }
  } finally {
    await release();
  }
}

const shutdown = (signal: string) => {
  if (stopping) process.exit(130);
  stopping = true;
  console.info(`[atlas-runtime] shutdown signal=${signal}`);
  runner?.stop("signal");
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  if (error instanceof RuntimeAlreadyRunningError) {
    console.info(`[atlas-runtime] singleton=${error.message}`);
    return;
  }
  console.error(`[atlas-runtime] fatal message=${safeMessage(error)}`);
  process.exitCode = 1;
});
