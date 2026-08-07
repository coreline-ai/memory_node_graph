import type { GitHubConnectorCapabilityRecord } from "./source-job-contracts.js";

export type GitHubCapabilityGuidance = {
  status: GitHubConnectorCapabilityRecord["status"] | "no_signal";
  tone: "ready" | "attention" | "critical";
  title: string;
  description: string;
  nextStep: string;
  command?: string;
  retryAt?: string;
  canRequestDiscovery: boolean;
  actionLabel: string;
};

export const GITHUB_CAPABILITY_STALE_MS = 45_000;

export function resolveGitHubCapabilityGuidance(
  capability: GitHubConnectorCapabilityRecord | undefined,
  now = Date.now(),
): GitHubCapabilityGuidance {
  if (!capability) {
    return {
      status: "no_signal",
      tone: "critical",
      title: "GitHub Connector 신호가 없습니다.",
      description: "저장소 목록을 읽을 로컬 Connector가 아직 capability 상태를 보고하지 않았습니다.",
      nextStep: "별도 터미널에서 Connector를 실행한 뒤 상태를 다시 확인하세요.",
      command: "npm run connector:start",
      canRequestDiscovery: true,
      actionLabel: "상태 다시 확인",
    };
  }

  const lastSeenAt = Date.parse(capability.lastSeenAt);
  if (!Number.isFinite(lastSeenAt) || now - lastSeenAt > GITHUB_CAPABILITY_STALE_MS) {
    return {
      status: "no_signal",
      tone: "critical",
      title: "GitHub Connector 신호가 오래되었습니다.",
      description: "마지막 capability 보고가 만료되어 이전 온라인 상태를 신뢰하지 않습니다.",
      nextStep: "Connector를 다시 실행한 뒤 상태를 다시 확인하세요.",
      command: "npm run connector:start",
      canRequestDiscovery: true,
      actionLabel: "상태 다시 확인",
    };
  }

  if (capability.status === "online") {
    return {
      status: "online",
      tone: "ready",
      title: "GitHub Connector가 준비되었습니다.",
      description: "현재 로컬 gh 로그인으로 discovery, preview, apply 작업을 실행할 수 있습니다.",
      nextStep: "저장소 찾기 또는 저장소 다시 찾기를 실행하세요.",
      canRequestDiscovery: true,
      actionLabel: "저장소 다시 찾기",
    };
  }

  if (capability.status === "login_required") {
    return {
      status: "login_required",
      tone: "attention",
      title: "GitHub CLI 로그인이 필요합니다.",
      description: "브라우저에 토큰을 입력하지 않습니다. Connector가 실행되는 로컬 환경에서 gh 로그인만 완료하면 됩니다.",
      nextStep: "로그인을 마친 뒤 이 화면에서 상태를 다시 확인하세요.",
      command: "gh auth login --hostname github.com",
      canRequestDiscovery: true,
      actionLabel: "로그인 후 재확인",
    };
  }

  if (capability.status === "forbidden") {
    return {
      status: "forbidden",
      tone: "attention",
      title: "coreline-ai 저장소 접근 권한을 확인하세요.",
      description: capability.accountLogin
        ? `현재 ${capability.accountLogin} 계정의 접근 범위가 대상 조직과 일치하지 않습니다.`
        : "현재 GitHub CLI 계정의 대상 조직 접근 범위를 확인할 수 없습니다.",
      nextStep: "올바른 계정으로 전환하거나 coreline-ai 저장소 권한을 받은 뒤 다시 확인하세요.",
      command: "gh auth status --hostname github.com",
      canRequestDiscovery: true,
      actionLabel: "권한 확인 후 재시도",
    };
  }

  if (capability.status === "rate_limited") {
    const resetAt = capability.rateLimitResetAt
      && Number.isFinite(Date.parse(capability.rateLimitResetAt))
      ? capability.rateLimitResetAt
      : undefined;
    const waiting = Boolean(resetAt && Date.parse(resetAt) > now);
    return {
      status: "rate_limited",
      tone: "attention",
      title: waiting ? "GitHub API 제한이 해제될 때까지 대기 중입니다." : "GitHub API 제한 상태를 다시 확인하세요.",
      description: "같은 discovery 요청을 반복해서 만들지 않습니다. 제한 해제 시점 이후에만 수동 재확인을 권장합니다.",
      nextStep: waiting
        ? "표시된 해제 시각 이후 상태 다시 확인을 실행하세요."
        : "GitHub API 제한 상태를 확인한 뒤 상태 다시 확인을 실행하세요.",
      command: "gh api rate_limit",
      retryAt: resetAt,
      canRequestDiscovery: !waiting,
      actionLabel: waiting ? "제한 해제 대기 중" : "제한 상태 재확인",
    };
  }

  if (capability.errorCode === "gh_missing") {
    return {
      status: "offline",
      tone: "critical",
      title: "GitHub CLI(gh)를 찾을 수 없습니다.",
      description: "Connector는 GitHub 자격 증명을 직접 저장하지 않으며, 로컬 gh CLI만 사용합니다.",
      nextStep: "gh를 설치한 뒤 Connector를 다시 실행하고 상태를 확인하세요.",
      command: "gh --version",
      canRequestDiscovery: true,
      actionLabel: "설치 후 재확인",
    };
  }

  return {
    status: "offline",
    tone: "critical",
    title: "GitHub Connector가 오프라인입니다.",
    description: "대시보드는 읽기 전용으로 유지됩니다. GitHub discovery와 원문 apply는 로컬 Connector가 연결된 경우에만 실행됩니다.",
    nextStep: "Connector를 실행하거나 연결을 복구한 뒤 상태를 다시 확인하세요.",
    command: "npm run connector:start",
    canRequestDiscovery: true,
    actionLabel: "Connector 재확인",
  };
}
