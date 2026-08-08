import assert from "node:assert/strict";
import test from "node:test";
import { cleanCodexEnvironment } from "../.runtime-dist/server/codex/codex-engine.js";

test("Codex SDK 자식 환경에서 API key와 내부 IPC 자격증명을 제거한다", () => {
  const clean = cleanCodexEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    OPENAI_API_KEY: "openai-secret",
    CODEX_API_KEY: "codex-secret",
    LIGHTRAG_API_KEY: "lightrag-secret",
    ATLAS_RUNTIME_ORIGIN: "runtime-secret",
    ATLAS_INTERNAL_RUNTIME_SECRET: "runtime-secret",
  });
  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.HOME, "/tmp/home");
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "LIGHTRAG_API_KEY",
    "ATLAS_RUNTIME_ORIGIN",
    "ATLAS_INTERNAL_RUNTIME_SECRET",
  ]) assert.equal(clean[key], undefined);
});
