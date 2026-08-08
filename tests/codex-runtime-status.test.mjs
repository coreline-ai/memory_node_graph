import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_RUNTIME_VERSION,
  deriveCodexRuntimeStatus,
} from "../.runtime-dist/app/lib/llm/codex-runtime-status.js";

const heartbeat = (overrides = {}) => ({
  runtimeId: "atlas-runtime-test",
  status: "online",
  version: CODEX_RUNTIME_VERSION,
  runtimeState: "connected",
  startedAt: "2026-08-08T00:00:00.000Z",
  lastSeenAt: "2026-08-08T00:00:30.000Z",
  ...overrides,
});

test("통합 OAuth 런타임 상태는 연결·실행·로그인·재로그인·실패를 구분한다", () => {
  const now = Date.parse("2026-08-08T00:00:40.000Z");
  assert.equal(deriveCodexRuntimeStatus([heartbeat()], now).state, "connected");
  assert.equal(deriveCodexRuntimeStatus([
    heartbeat({ runtimeState: "running", currentJobId: "job-1" }),
  ], now).state, "running");
  assert.equal(deriveCodexRuntimeStatus([
    heartbeat({ runtimeState: "login_required", runtimeMessage: "로그인 필요" }),
  ], now).state, "login_required");
  assert.equal(deriveCodexRuntimeStatus([
    heartbeat({ runtimeState: "reauth_required", runtimeMessage: "재로그인 필요" }),
  ], now).state, "reauth_required");
  assert.equal(deriveCodexRuntimeStatus([], now).state, "login_required");
  assert.equal(deriveCodexRuntimeStatus([
    heartbeat({ status: "offline", runtimeState: "reauth_required" }),
  ], now).state, "reauth_required");
  assert.equal(deriveCodexRuntimeStatus([
    heartbeat({ status: "offline", runtimeState: "failed" }),
  ], now).state, "failed");
});

test("45초 이상 오래된 online 신호는 사용 가능 상태로 오인하지 않는다", () => {
  const status = deriveCodexRuntimeStatus(
    [heartbeat({ lastSeenAt: "2026-08-08T00:00:00.000Z" })],
    Date.parse("2026-08-08T00:01:00.000Z"),
  );
  assert.equal(status.available, false);
  assert.equal(status.state, "failed");
});
