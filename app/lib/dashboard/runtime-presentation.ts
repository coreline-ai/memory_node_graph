import type { GitHubRuntimeStatus } from "../github/github-runtime-status";
import type { CodexRuntimeStatus } from "../llm/codex-runtime-status";

export type RuntimeTone = "ready" | "working" | "attention" | "blocked";

export type RuntimePresentation = {
  tone: RuntimeTone;
  label: string;
  title: string;
  description: string;
  nextStep: string;
  command?: string;
};

export function presentCodexRuntime(status: CodexRuntimeStatus): RuntimePresentation {
  if (status.state === "running") return {
    tone: "working",
    label: "관계 보강 중",
    title: "Codex OAuth 분석 실행 중",
    description: status.message,
    nextStep: "완료되면 문서별 AI 보강 상태와 관계 수가 자동으로 갱신됩니다.",
  };
  if (status.state === "connected") return {
    tone: "ready",
    label: "OAuth 연결됨",
    title: "Codex 관계 보강 사용 가능",
    description: status.message,
    nextStep: "Markdown 기본 그래프와 선택형 Codex 관계 보강을 함께 사용할 수 있습니다.",
  };
  if (status.state === "reauth_required") return {
    tone: "attention",
    label: "재로그인 필요",
    title: "Codex OAuth 세션 갱신 필요",
    description: status.message,
    nextStep: "터미널에서 로그인한 뒤 이 화면의 상태 다시 확인을 누르세요.",
    command: "codex login",
  };
  if (status.state === "login_required") return {
    tone: "attention",
    label: "로그인 필요",
    title: "Codex 보강은 선택 사항입니다",
    description: status.message,
    nextStep: "기본 Markdown 그래프는 로그인 없이 동작합니다. AI 보강이 필요할 때만 로그인하세요.",
    command: "codex login",
  };
  return {
    tone: "blocked",
    label: "실행 확인",
    title: "Codex 관계 보강 중단",
    description: status.message,
    nextStep: "실패한 문서의 원인을 확인하고 재시도를 실행하세요.",
  };
}

export function presentGitHubRuntime(status: GitHubRuntimeStatus): RuntimePresentation {
  if (status.state === "connected") return {
    tone: "ready",
    label: "GitHub 연결됨",
    title: "저장소 동기화 사용 가능",
    description: status.message,
    nextStep: "저장소 찾기, Preview, Apply를 이 웹앱에서 바로 실행할 수 있습니다.",
  };
  if (status.state === "login_required") return {
    tone: "attention",
    label: "로그인 필요",
    title: "GitHub OAuth 연결 필요",
    description: status.message,
    nextStep: "GitHub CLI 로그인을 완료한 뒤 상태 다시 확인을 누르세요.",
    command: "gh auth login --hostname github.com",
  };
  if (status.state === "forbidden") return {
    tone: "blocked",
    label: "권한 확인",
    title: "저장소 읽기 권한 필요",
    description: status.message,
    nextStep: "현재 GitHub 계정이 대상 조직과 저장소를 읽을 수 있는지 확인하세요.",
    command: "gh auth status --hostname github.com",
  };
  if (status.state === "rate_limited") return {
    tone: "attention",
    label: "요청 제한",
    title: "GitHub 요청 제한 대기",
    description: status.message,
    nextStep: status.rateLimitResetAt
      ? `제한 해제 예상: ${status.rateLimitResetAt}`
      : "잠시 후 상태를 다시 확인하세요.",
  };
  return {
    tone: "blocked",
    label: "상태 확인",
    title: "GitHub 동기화 상태 확인 필요",
    description: status.message,
    nextStep: "통합 웹앱이 실행 중인지 확인한 뒤 상태를 다시 확인하세요.",
  };
}
