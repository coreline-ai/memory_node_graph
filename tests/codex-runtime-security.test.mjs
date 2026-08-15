import assert from "node:assert/strict";
import test from "node:test";
import {
  assertCodexOutputSafe,
  cleanCodexEnvironment,
} from "../.runtime-dist/server/codex/codex-engine.js";
import { assertRuntimeProductionConfiguration } from "../.runtime-dist/server/runtime/config.js";

test("Codex SDK 자식 환경은 OAuth 실행에 필요한 allowlist만 전달한다", () => {
  const clean = cleanCodexEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex-home",
    LANG: "ko_KR.UTF-8",
    OPENAI_API_KEY: "openai-secret",
    CODEX_API_KEY: "codex-secret",
    LIGHTRAG_API_KEY: "lightrag-secret",
    GH_TOKEN: "github-secret",
    GITHUB_TOKEN: "github-actions-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    NPM_TOKEN: "npm-secret",
    DATABASE_URL: "postgres://secret",
    FMP_API_KEY: "fmp-secret",
    NODE_OPTIONS: "--require=/tmp/untrusted.js",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    ATLAS_RUNTIME_ORIGIN: "runtime-secret",
    ATLAS_INTERNAL_RUNTIME_SECRET: "runtime-secret",
  });
  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.HOME, "/tmp/home");
  assert.equal(clean.CODEX_HOME, "/tmp/codex-home");
  assert.equal(clean.LANG, "ko_KR.UTF-8");
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "LIGHTRAG_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "NPM_TOKEN",
    "DATABASE_URL",
    "FMP_API_KEY",
    "NODE_OPTIONS",
    "SSH_AUTH_SOCK",
    "ATLAS_RUNTIME_ORIGIN",
    "ATLAS_INTERNAL_RUNTIME_SECRET",
  ]) assert.equal(clean[key], undefined);
});

test("Codex 출력 비밀 guard는 실제 환경 sentinel과 알려진 token 형식을 격리한다", () => {
  assert.doesNotThrow(() => assertCodexOutputSafe(
    JSON.stringify({ note: "근거에 기반한 정상 관계 설명", hash: "a".repeat(64) }),
    { FMP_API_KEY: "sensitive-fmp-value" },
  ));
  assert.throws(
    () => assertCodexOutputSafe(
      JSON.stringify({ note: "sensitive-fmp-value" }),
      { FMP_API_KEY: "sensitive-fmp-value" },
    ),
    /결과를 격리/,
  );
  assert.throws(
    () => assertCodexOutputSafe(
      JSON.stringify({ note: `github_pat_${"a".repeat(32)}` }),
      {},
    ),
    /결과를 격리/,
  );
});

test("production runtime configuration rejects ATLAS_TEST_MODE", () => {
  assert.doesNotThrow(() => assertRuntimeProductionConfiguration({
    NODE_ENV: "test",
    ATLAS_TEST_MODE: "true",
  }));
  assert.throws(
    () => assertRuntimeProductionConfiguration({
      NODE_ENV: "production",
      ATLAS_TEST_MODE: "true",
    }),
    /ATLAS_TEST_MODE/,
  );
});
