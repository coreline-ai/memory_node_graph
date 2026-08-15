import { hostname } from "node:os";
import {
  CODEX_RUNTIME_VERSION,
  INTEGRATED_CODEX_PROVIDER_VERSION,
} from "../../app/lib/llm/codex-runtime-status.js";
import { INTEGRATED_GITHUB_RUNTIME_VERSION } from "../../app/lib/github/source-job-contracts.js";

const numberFrom = (name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
};

export function assertRuntimeProductionConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (environment.NODE_ENV === "production" && environment.ATLAS_TEST_MODE === "true") {
    throw new Error("production에서는 ATLAS_TEST_MODE를 사용할 수 없습니다.");
  }
}

/**
 * Private configuration for the single local OAuth runtime. It deliberately
 * carries no OpenAI/GitHub API key and no browser-facing credential.
 */
export type IntegratedRuntimeConfig = Readonly<{
  baseUrl: string;
  internalRuntimeSecret: string;
  runtimeId: string;
  pollIntervalMs: number;
  statusIntervalMs: number;
  leaseDurationMs: number;
  codexTimeoutMs: number;
  githubTimeoutMs: number;
  maxInputBytes: number;
  maximumBackoffMs: number;
  model?: string;
  codexPath?: string;
  ghPath?: string;
  deleteSessionAfterRun: boolean;
  version: string;
  providerVersion?: string;
  githubRuntimeVersion?: string;
}>;

export const codexRuntimeConfig = Object.freeze({
  baseUrl: (process.env.ATLAS_RUNTIME_ORIGIN?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
  internalRuntimeSecret: process.env.ATLAS_INTERNAL_RUNTIME_SECRET?.trim() || "",
  runtimeId: process.env.ATLAS_RUNTIME_ID?.trim()
    || `atlas-runtime-${hostname().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 48)}`,
  pollIntervalMs: numberFrom("ATLAS_RUNTIME_POLL_MS", 2_000, 250, 60_000),
  statusIntervalMs: numberFrom("ATLAS_RUNTIME_STATUS_MS", 15_000, 5_000, 30_000),
  leaseDurationMs: numberFrom("ATLAS_RUNTIME_LEASE_MS", 90_000, 15_000, 300_000),
  codexTimeoutMs: numberFrom("ATLAS_CODEX_TIMEOUT_MS", 180_000, 15_000, 900_000),
  githubTimeoutMs: numberFrom("ATLAS_GITHUB_TIMEOUT_MS", 120_000, 15_000, 300_000),
  maxInputBytes: numberFrom("ATLAS_CODEX_MAX_INPUT_BYTES", 256_000, 16_000, 512_000),
  maximumBackoffMs: numberFrom("ATLAS_RUNTIME_MAX_BACKOFF_MS", 30_000, 1_000, 120_000),
  model: process.env.ATLAS_CODEX_MODEL?.trim() || undefined,
  codexPath: process.env.ATLAS_CODEX_PATH?.trim() || undefined,
  ghPath: process.env.ATLAS_GH_PATH?.trim() || undefined,
  deleteSessionAfterRun: process.env.ATLAS_CODEX_KEEP_SESSIONS?.trim().toLowerCase() !== "true",
  version: CODEX_RUNTIME_VERSION,
  providerVersion: INTEGRATED_CODEX_PROVIDER_VERSION,
  githubRuntimeVersion: INTEGRATED_GITHUB_RUNTIME_VERSION,
}) satisfies IntegratedRuntimeConfig;
