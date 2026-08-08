import {
  INTEGRATED_GITHUB_RUNTIME_VERSION,
  type GitHubRuntimeCapabilityRecord,
} from "./source-job-contracts.js";

export const GITHUB_RUNTIME_CAPABILITY_STALE_MS = 45_000;

export type GitHubRuntimeState =
  | "connected"
  | "login_required"
  | "forbidden"
  | "rate_limited"
  | "unavailable";

export type GitHubRuntimeStatus = {
  version: string;
  state: GitHubRuntimeState;
  available: boolean;
  authenticated: boolean;
  authorized: boolean;
  checkedAt?: string;
  lastSeenAt?: string;
  rateLimitResetAt?: string;
  message: string;
};

const integratedCapability = (capabilities: readonly GitHubRuntimeCapabilityRecord[]) =>
  capabilities
    .filter((capability) => capability.runtimeId.startsWith("atlas-runtime-"))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))[0];

export function projectGitHubRuntimeStatus(
  capabilities: readonly GitHubRuntimeCapabilityRecord[],
  now = Date.now(),
): GitHubRuntimeStatus {
  const capability = integratedCapability(capabilities);
  const seenAt = capability ? Date.parse(capability.lastSeenAt) : Number.NaN;
  if (
    !capability
    || !Number.isFinite(seenAt)
    || now - seenAt > GITHUB_RUNTIME_CAPABILITY_STALE_MS
  ) {
    return {
      version: INTEGRATED_GITHUB_RUNTIME_VERSION,
      state: "unavailable",
      available: false,
      authenticated: false,
      authorized: false,
      message: "통합 GitHub 동기화 런타임의 최근 상태를 확인할 수 없습니다.",
    };
  }

  const common = {
    version: INTEGRATED_GITHUB_RUNTIME_VERSION,
    checkedAt: capability.checkedAt,
    lastSeenAt: capability.lastSeenAt,
    rateLimitResetAt: capability.rateLimitResetAt,
  };
  if (capability.status === "online") {
    return {
      ...common,
      state: "connected",
      available: true,
      authenticated: true,
      authorized: true,
      message: "로컬 GitHub OAuth 세션으로 문서 동기화를 사용할 수 있습니다.",
    };
  }
  if (capability.status === "login_required") {
    return {
      ...common,
      state: "login_required",
      available: false,
      authenticated: false,
      authorized: false,
      message: "GitHub 로그인이 필요합니다.",
    };
  }
  if (capability.status === "forbidden") {
    return {
      ...common,
      state: "forbidden",
      available: false,
      authenticated: true,
      authorized: false,
      message: "coreline-ai 저장소 읽기 권한을 확인해야 합니다.",
    };
  }
  if (capability.status === "rate_limited") {
    return {
      ...common,
      state: "rate_limited",
      available: false,
      authenticated: true,
      authorized: true,
      message: "GitHub 요청 제한이 해제될 때까지 동기화를 대기합니다.",
    };
  }
  return {
    ...common,
    state: "unavailable",
    available: false,
    authenticated: false,
    authorized: false,
    message: capability.errorCode === "gh_missing"
      ? "GitHub CLI를 찾을 수 없습니다."
      : "GitHub 동기화 런타임을 사용할 수 없습니다.",
  };
}
