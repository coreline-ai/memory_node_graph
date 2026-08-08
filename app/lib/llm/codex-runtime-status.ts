import type {
  CodexRuntimeState,
  RuntimeStatusRecord,
} from "./enrichment-contracts";

export const CODEX_RUNTIME_VERSION = "atlas-integrated-codex-runtime-1";
export const INTEGRATED_CODEX_PROVIDER_VERSION = "codex-sdk-0.146.0+atlas-runtime.1";
export const CODEX_RUNTIME_ONLINE_WINDOW_MS = 45_000;

export type CodexRuntimeStatus = {
  state: CodexRuntimeState;
  available: boolean;
  authenticated: boolean;
  activeJobId?: string;
  lastSeenAt?: string;
  message: string;
};

const isFresh = (heartbeat: RuntimeStatusRecord, now: number) => {
  const seen = Date.parse(heartbeat.lastSeenAt);
  return Number.isFinite(seen) && now - seen <= CODEX_RUNTIME_ONLINE_WINDOW_MS;
};

export function deriveCodexRuntimeStatus(
  heartbeats: readonly RuntimeStatusRecord[],
  now = Date.now(),
): CodexRuntimeStatus {
  const runtimeHeartbeats = heartbeats
    .filter((heartbeat) => heartbeat.version.startsWith(CODEX_RUNTIME_VERSION))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  const current = runtimeHeartbeats.find((heartbeat) => heartbeat.status === "online" && isFresh(heartbeat, now));
  const latest = current ?? runtimeHeartbeats[0];

  if (current) {
    if (current.runtimeState === "login_required") {
      return {
        state: "login_required",
        available: false,
        authenticated: false,
        lastSeenAt: current.lastSeenAt,
        message: current.runtimeMessage || "Codex OAuth 로그인이 필요합니다.",
      };
    }
    if (current.runtimeState === "reauth_required") {
      return {
        state: "reauth_required",
        available: false,
        authenticated: false,
        lastSeenAt: current.lastSeenAt,
        message: current.runtimeMessage || "Codex OAuth 세션을 다시 연결해야 합니다.",
      };
    }
    if (current.runtimeState === "failed") {
      return {
        state: "failed",
        available: false,
        authenticated: false,
        lastSeenAt: current.lastSeenAt,
        message: current.runtimeMessage || "Codex 관계 보강 작업을 시작하지 못했습니다.",
      };
    }
    const running = current.runtimeState === "running" || Boolean(current.currentJobId);
    return {
      state: running ? "running" : "connected",
      available: true,
      authenticated: true,
      activeJobId: current.currentJobId,
      lastSeenAt: current.lastSeenAt,
      message: running ? "Codex OAuth 관계 보강을 처리하고 있습니다." : "Codex OAuth 세션이 연결되어 있습니다.",
    };
  }

  if (latest?.runtimeState === "reauth_required") {
    return {
      state: "reauth_required",
      available: false,
      authenticated: false,
      lastSeenAt: latest.lastSeenAt,
      message: latest.runtimeMessage || "Codex OAuth 세션을 다시 연결해야 합니다.",
    };
  }
  if (latest?.runtimeState === "login_required" || !latest) {
    return {
      state: "login_required",
      available: false,
      authenticated: false,
      lastSeenAt: latest?.lastSeenAt,
      message: latest?.runtimeMessage || "Codex OAuth 로그인이 필요합니다.",
    };
  }
  return {
    state: "failed",
    available: false,
    authenticated: latest.runtimeState === "connected",
    lastSeenAt: latest.lastSeenAt,
    message: latest.runtimeMessage || "통합 Codex 작업 런타임이 중지되었습니다.",
  };
}
