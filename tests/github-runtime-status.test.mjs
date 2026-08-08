import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_RUNTIME_CAPABILITY_STALE_MS,
  projectGitHubRuntimeStatus,
} from "../.runtime-dist/app/lib/github/github-runtime-status.js";

const capability = (overrides = {}) => ({
  runtimeId: "atlas-runtime-test-host",
  capability: "github-source",
  status: "online",
  accountLogin: "coreline-ai",
  host: "github.com",
  checkedAt: "2026-08-08T00:00:00.000Z",
  lastSeenAt: "2026-08-08T00:00:00.000Z",
  ...overrides,
});

test("GitHub runtime 상태는 통합 런타임만 선택하고 계정·저장소 메타데이터를 투영하지 않는다", () => {
  const now = Date.parse("2026-08-08T00:00:10.000Z");
  const projected = projectGitHubRuntimeStatus([
    capability({
      runtimeId: "atlas-legacy-runtime",
      accountLogin: "private-account",
      lastSeenAt: "2026-08-08T00:00:09.000Z",
    }),
    capability(),
  ], now);
  assert.equal(projected.state, "connected");
  assert.equal(projected.available, true);
  assert.equal(projected.authenticated, true);
  assert.equal("accountLogin" in projected, false);
  assert.equal("runtimeId" in projected, false);
  assert.doesNotMatch(JSON.stringify(projected), /private-account|repository|relativePath/i);
});

test("GitHub runtime 상태는 로그인·권한·제한·stale을 독립 상태로 구분한다", () => {
  const now = Date.parse("2026-08-08T00:00:10.000Z");
  assert.equal(projectGitHubRuntimeStatus([capability({
    status: "login_required",
    errorCode: "gh_auth_required",
  })], now).state, "login_required");
  assert.equal(projectGitHubRuntimeStatus([capability({
    status: "forbidden",
    errorCode: "github_forbidden",
  })], now).state, "forbidden");
  assert.equal(projectGitHubRuntimeStatus([capability({
    status: "rate_limited",
    errorCode: "github_rate_limited",
  })], now).state, "rate_limited");
  assert.equal(projectGitHubRuntimeStatus([capability()],
    Date.parse("2026-08-08T00:00:00.000Z") + GITHUB_RUNTIME_CAPABILITY_STALE_MS + 1,
  ).state, "unavailable");
});
