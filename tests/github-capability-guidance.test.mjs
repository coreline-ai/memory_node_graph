import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveGitHubCapabilityGuidance,
} from "../.runtime-dist/app/lib/github/capability-guidance.js";

const checkedAt = "2026-08-05T06:40:00.000Z";
const currentTime = Date.parse("2026-08-05T06:40:20.000Z");
const capability = (status, overrides = {}) => ({
  runtimeId: "runtime-fixture",
  capability: "github-source",
  status,
  checkedAt,
  lastSeenAt: checkedAt,
  ...overrides,
});

test("초기 상태와 통합 런타임 오프라인은 서로 다른 복구 안내를 제공한다", () => {
  const noSignal = resolveGitHubCapabilityGuidance(undefined);
  const offline = resolveGitHubCapabilityGuidance(capability("offline", {
    errorCode: "runtime_unavailable",
  }), currentTime);

  assert.equal(noSignal.status, "unavailable");
  assert.match(noSignal.title, /확인/);
  assert.equal(noSignal.command, undefined);
  assert.equal(offline.status, "offline");
  assert.match(offline.title, /오프라인/);
  assert.notEqual(offline.title, noSignal.title);
});

test("오래된 온라인 capability는 현재 연결로 오인하지 않고 갱신 대기로 전환한다", () => {
  const stale = resolveGitHubCapabilityGuidance(capability("online", {
    accountLogin: "coreline-ai",
    lastSeenAt: "2026-08-05T06:40:00.000Z",
  }), Date.parse("2026-08-05T06:41:00.000Z"));

  assert.equal(stale.status, "unavailable");
  assert.match(stale.title, /갱신/);
  assert.equal(stale.command, undefined);
});

test("로그인과 권한 부족은 자격 증명을 노출하지 않는 별도 로컬 조치를 안내한다", () => {
  const login = resolveGitHubCapabilityGuidance(capability("login_required", {
    errorCode: "gh_auth_required",
  }), currentTime);
  const forbidden = resolveGitHubCapabilityGuidance(capability("forbidden", {
    errorCode: "github_forbidden",
    accountLogin: "other-account",
  }), currentTime);

  assert.equal(login.command, "gh auth login --hostname github.com");
  assert.match(login.description, /토큰을 입력하지 않습니다/);
  assert.match(forbidden.description, /other-account/);
  assert.equal(forbidden.command, "gh auth status --hostname github.com");
});

test("rate limit은 해제 전에는 discovery 재요청을 막고 해제 후 재확인을 허용한다", () => {
  const resetAt = "2026-08-05T07:00:00.000Z";
  const rateLimited = capability("rate_limited", {
    errorCode: "github_rate_limited",
    rateLimitResetAt: resetAt,
    lastSeenAt: "2026-08-05T06:49:50.000Z",
  });

  const waiting = resolveGitHubCapabilityGuidance(rateLimited, Date.parse("2026-08-05T06:50:00.000Z"));
  const available = resolveGitHubCapabilityGuidance({
    ...rateLimited,
    lastSeenAt: "2026-08-05T07:00:50.000Z",
  }, Date.parse("2026-08-05T07:01:00.000Z"));
  assert.equal(waiting.canRequestDiscovery, false);
  assert.equal(waiting.actionLabel, "제한 해제 대기 중");
  assert.equal(waiting.retryAt, resetAt);
  assert.equal(available.canRequestDiscovery, true);
  assert.equal(available.actionLabel, "제한 상태 재확인");
});

test("gh 미설치와 정상 연결은 설치 확인·일반 discovery 안내를 각각 제공한다", () => {
  const missing = resolveGitHubCapabilityGuidance(capability("offline", {
    errorCode: "gh_missing",
  }), currentTime);
  const online = resolveGitHubCapabilityGuidance(capability("online", {
    accountLogin: "coreline-ai",
  }), currentTime);

  assert.equal(missing.command, "gh --version");
  assert.match(missing.title, /찾을 수 없습니다/);
  assert.equal(online.status, "online");
  assert.equal(online.canRequestDiscovery, true);
});
