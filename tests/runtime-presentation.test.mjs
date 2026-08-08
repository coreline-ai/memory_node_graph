import assert from "node:assert/strict";
import test from "node:test";
import {
  presentCodexRuntime,
  presentGitHubRuntime,
} from "../.runtime-dist/app/lib/dashboard/runtime-presentation.js";

test("Codex OAuth 상태는 기본 그래프와 선택 보강을 혼동하지 않게 안내한다", () => {
  const login = presentCodexRuntime({
    state: "login_required",
    available: false,
    authenticated: false,
    message: "Codex OAuth 로그인이 필요합니다.",
  });
  assert.equal(login.label, "로그인 필요");
  assert.match(login.nextStep, /기본 Markdown 그래프는 로그인 없이/);
  assert.equal(login.command, "codex login");

  const running = presentCodexRuntime({
    state: "running",
    available: true,
    authenticated: true,
    message: "처리 중",
  });
  assert.equal(running.tone, "working");
  assert.equal(running.label, "관계 보강 중");
});

test("GitHub OAuth 상태는 통합 런타임 실행 명령 없이 독립적으로 안내한다", () => {
  const connected = presentGitHubRuntime({
    version: "test",
    state: "connected",
    available: true,
    authenticated: true,
    authorized: true,
    message: "연결됨",
  });
  assert.equal(connected.label, "GitHub 연결됨");
  assert.match(connected.nextStep, /웹앱에서 바로/);

  const login = presentGitHubRuntime({
    version: "test",
    state: "login_required",
    available: false,
    authenticated: false,
    authorized: false,
    message: "로그인 필요",
  });
  assert.equal(login.command, "gh auth login --hostname github.com");
  assert.doesNotMatch(`${login.nextStep} ${login.command}`, /runtime:start/i);
});
