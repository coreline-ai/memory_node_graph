import assert from "node:assert/strict";
import test from "node:test";
import { IntegratedRuntimeClient } from "../.runtime-dist/server/runtime/client.js";

test("통합 runtime client는 GitHub source claim에 generation을 전달한다", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ job: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const client = new IntegratedRuntimeClient({
      baseUrl: "http://localhost:3000",
      internalRuntimeSecret: "ephemeral-ipc-only",
      runtimeId: "atlas-runtime-test",
      pollIntervalMs: 1,
      statusIntervalMs: 10_000,
      leaseDurationMs: 90_000,
      codexTimeoutMs: 180_000,
      githubTimeoutMs: 120_000,
      maxInputBytes: 256_000,
      maximumBackoffMs: 10,
      deleteSessionAfterRun: true,
      version: "atlas-integrated-codex-runtime-1",
      githubRuntimeVersion: "atlas-integrated-github-runtime-1",
    });
    assert.equal(await client.claimGitHubSource(), null);
    assert.equal(captured.url, "http://localhost:3000/api/github/source-jobs/claim");
    assert.deepEqual(JSON.parse(captured.init.body), {
      leaseDurationMs: 90_000,
      runtimeVersion: "atlas-integrated-github-runtime-1",
    });
    assert.equal(
      new Headers(captured.init.headers).get("x-atlas-internal-runtime-secret"),
      "ephemeral-ipc-only",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
