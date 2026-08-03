import { hostname } from "node:os";

const numberFrom = (name: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
};

const connectorId = process.env.ATLAS_CONNECTOR_ID?.trim()
  || `atlas-${hostname().replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 48)}-${process.pid}`;

export const connectorConfig = Object.freeze({
  baseUrl: (process.env.ATLAS_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/, ""),
  token: process.env.ATLAS_CONNECTOR_TOKEN?.trim() || "",
  connectorId,
  pollIntervalMs: numberFrom("ATLAS_CONNECTOR_POLL_MS", 2_000, 250, 60_000),
  heartbeatIntervalMs: numberFrom("ATLAS_CONNECTOR_HEARTBEAT_MS", 15_000, 5_000, 30_000),
  leaseDurationMs: numberFrom("ATLAS_CONNECTOR_LEASE_MS", 90_000, 15_000, 300_000),
  codexTimeoutMs: numberFrom("ATLAS_CODEX_TIMEOUT_MS", 180_000, 15_000, 900_000),
  maxInputBytes: numberFrom("ATLAS_CODEX_MAX_INPUT_BYTES", 256_000, 16_000, 512_000),
  maximumBackoffMs: numberFrom("ATLAS_CONNECTOR_MAX_BACKOFF_MS", 30_000, 1_000, 120_000),
  model: process.env.ATLAS_CODEX_MODEL?.trim() || undefined,
  codexPath: process.env.ATLAS_CODEX_PATH?.trim() || undefined,
  deleteSessionAfterRun: process.env.ATLAS_CODEX_KEEP_SESSIONS?.trim().toLowerCase() !== "true",
  version: "atlas-connector-1",
});

export type ConnectorConfig = typeof connectorConfig;
