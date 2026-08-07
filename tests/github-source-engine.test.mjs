import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GitHubSourceEngine } from "../.connector-dist/connector/github-source-engine.js";

const config = {
  baseUrl: "http://localhost:3000",
  token: "",
  connectorId: "github-engine-test",
  pollIntervalMs: 1,
  heartbeatIntervalMs: 10_000,
  leaseDurationMs: 90_000,
  codexTimeoutMs: 180_000,
  githubTimeoutMs: 120_000,
  maxInputBytes: 256_000,
  maximumBackoffMs: 10,
  model: undefined,
  codexPath: undefined,
  ghPath: "gh-test",
  deleteSessionAfterRun: true,
  version: "atlas-connector-test",
};

const repository = (overrides) => ({
  repositoryId: "1001",
  owner: "coreline-ai",
  name: "atlas-runtime",
  visibility: "public",
  isPrivate: false,
  isFork: false,
  isArchived: false,
  isTemplate: false,
  defaultBranch: "main",
  updatedAt: "2026-08-04T00:00:00.000Z",
  url: "https://github.com/coreline-ai/atlas-runtime",
  ...overrides,
});

const sourceJob = {
  id: "github-source:discovery:test",
  idempotencyKey: "abc123",
  kind: "discovery",
  owner: "coreline-ai",
  status: "leased",
  input: {
    jobId: "github-source:discovery:test",
    idempotencyKey: "abc123",
    kind: "discovery",
    owner: "coreline-ai",
    selectedRepositoryIds: [],
  },
  attemptCount: 1,
  maxAttempts: 3,
  manualRetryCount: 0,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

const previewJob = {
  ...sourceJob,
  id: "github-source:preview:test",
  idempotencyKey: "preview-abc123",
  kind: "preview",
  input: {
    ...sourceJob.input,
    jobId: "github-source:preview:test",
    idempotencyKey: "preview-abc123",
    kind: "preview",
    selectedRepositoryIds: ["1001"],
  },
};

const gitBlobSha = (content) => {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

test("GitHub source engine은 keyring gh 인증으로 숫자 repository ID 목록만 정제한다", async () => {
  const calls = [];
  const repositories = [
    repository({}),
    repository({
      repositoryId: "1002",
      name: "product-demo",
      visibility: "private",
      isPrivate: true,
      url: "https://github.com/coreline-ai/product-demo",
    }),
    repository({
      repositoryId: "1003",
      name: "upstream-fork",
      isFork: true,
      url: "https://github.com/coreline-ai/upstream-fork",
    }),
    repository({
      repositoryId: "1004",
      name: "legacy-service",
      isArchived: true,
      url: "https://github.com/coreline-ai/legacy-service",
    }),
  ];
  const execute = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (args[0] === "--version") return { stdout: "gh version 2.83.2", stderr: "" };
    if (args[0] === "auth") return {
      stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, login: "coreline-ai", state: "success" }] } }),
      stderr: "",
    };
    if (args[0] === "api") return {
      stdout: repositories.map((item) => JSON.stringify(item)).join("\n"),
      stderr: "",
    };
    throw new Error("unexpected command");
  };
  process.env.GH_TOKEN = "must-not-reach-child-process";
  process.env.GITHUB_TOKEN = "must-not-reach-child-process";
  try {
    const engine = new GitHubSourceEngine(config, {
      execute,
      now: () => "2026-08-04T01:02:03.000Z",
    });
    const result = await engine.discover(sourceJob);
    assert.equal(result.capability.status, "online");
    assert.equal(result.capability.accountLogin, "coreline-ai");
    assert.deepEqual(result.discovery.totals, {
      total: 4,
      public: 3,
      private: 1,
      internal: 0,
      fork: 1,
      archived: 1,
      template: 0,
      recommended: 2,
      selected: 2,
      warnings: 1,
    });
    assert.deepEqual(result.discovery.selection.selectedRepositoryIds, ["1001", "1002"]);
    assert.equal(result.summary.discoveredCount, 4);
    assert.equal(result.summary.selectedCount, 2);
    assert.ok(calls.some((call) => call.args.includes("user/repos?per_page=100&affiliation=owner&visibility=all")));
    assert.ok(calls.every((call) => !("GH_TOKEN" in call.env) && !("GITHUB_TOKEN" in call.env)));
    assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes("token"))));
  } finally {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  }
});

test("GitHub source engine은 gh 미설치·로그아웃·다른 계정을 구분한다", async () => {
  const missing = new GitHubSourceEngine(config, {
    execute: async () => {
      const error = new Error("spawn gh ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(await missing.checkCapability()).filter(([key]) => ["status", "errorCode"].includes(key))),
    { status: "offline", errorCode: "gh_missing" },
  );

  const accountCapability = async (login, state) => new GitHubSourceEngine(config, {
    execute: async (_command, args) => args[0] === "--version"
      ? { stdout: "gh version", stderr: "" }
      : {
          stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, login, state }] } }),
          stderr: "",
        },
  }).checkCapability();
  const loggedOut = await accountCapability("coreline-ai", "error");
  assert.equal(loggedOut.status, "login_required");
  assert.equal(loggedOut.errorCode, "gh_auth_required");
  const wrongAccount = await accountCapability("another-user", "success");
  assert.equal(wrongAccount.status, "forbidden");
  assert.equal(wrongAccount.errorCode, "github_forbidden");
});

test("GitHub source preview는 truncated tree를 Contents metadata로 보완하고 원문은 내려받지 않는다", async () => {
  const calls = [];
  const commitSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const execute = async (_command, args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "gh version 2.83.2", stderr: "" };
    if (args[0] === "auth") return {
      stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, login: "coreline-ai", state: "success" }] } }),
      stderr: "",
    };
    const endpoint = args[1];
    if (endpoint === "repositories/1001") return { stdout: JSON.stringify(repository({})), stderr: "" };
    if (endpoint.includes("/commits/")) return {
      stdout: JSON.stringify({ commitSha, treeSha }),
      stderr: "",
    };
    if (endpoint.includes("/git/trees/")) return {
      stdout: JSON.stringify({ truncated: true, entries: [] }),
      stderr: "",
    };
    if (endpoint.includes("/contents/README.md")) return {
      stdout: JSON.stringify([{ path: "README.md", type: "file", sha: "c".repeat(40), size: 2048 }]),
      stderr: "",
    };
    if (endpoint.includes("/contents/dev-plan?")) return {
      stdout: JSON.stringify([
        { path: "dev-plan/phase-1.md", type: "file", sha: "d".repeat(40), size: 1024 },
        { path: "dev-plan/archive", type: "dir", sha: "e".repeat(40), size: 0 },
      ]),
      stderr: "",
    };
    if (endpoint.includes("/contents/dev-plan/archive")) return {
      stdout: JSON.stringify([{ path: "dev-plan/archive/phase-0.md", type: "file", sha: "f".repeat(40), size: 512 }]),
      stderr: "",
    };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const engine = new GitHubSourceEngine(config, {
    execute,
    now: () => "2026-08-04T02:03:04.000Z",
  });
  const result = await engine.preview(previewJob);
  assert.equal(result.kind, "preview");
  assert.equal(result.preview.status, "ready");
  assert.deepEqual(result.preview.totals, {
    repositories: 1,
    ready: 1,
    blocked: 0,
    files: 3,
    readme: 1,
    devPlan: 2,
    bytes: 3584,
    skipped: 0,
  });
  assert.equal(result.preview.repositories[0].treeStrategy, "contents-fallback");
  assert.deepEqual(
    result.preview.repositories[0].files.map((file) => file.path),
    ["dev-plan/archive/phase-0.md", "dev-plan/phase-1.md", "README.md"],
  );
  assert.ok(calls.some((args) => String(args[1]).includes("/git/trees/")));
  assert.ok(calls.some((args) => String(args[1]).includes("/contents/dev-plan/archive")));
  assert.ok(calls.every((args) => !String(args[1] ?? "").includes("raw.githubusercontent.com")));
});

test("GitHub source apply는 승인 manifest를 재검증하고 BOM을 포함한 대상 Blob을 무결성 확인 후 전달한다", async () => {
  const readme = "\uFEFF# Atlas Runtime\n\n## 기술 스택\n\n- `TypeScript`\n";
  const plan = "# 구현 계획\n\n## Phase 1\n\n- [x] parser 연결\n";
  const blobs = new Map([
    [gitBlobSha(readme), readme],
    [gitBlobSha(plan), plan],
  ]);
  const commitSha = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const calls = [];
  const execute = async (_command, args) => {
    calls.push(args);
    if (args[0] === "--version") return { stdout: "gh version 2.83.2", stderr: "" };
    if (args[0] === "auth") return {
      stdout: JSON.stringify({ hosts: { "github.com": [{ active: true, login: "coreline-ai", state: "success" }] } }),
      stderr: "",
    };
    const endpoint = args[1];
    if (endpoint === "repositories/1001") return { stdout: JSON.stringify(repository({})), stderr: "" };
    if (endpoint.includes("/commits/")) return { stdout: JSON.stringify({ commitSha, treeSha }), stderr: "" };
    if (endpoint.includes("/git/trees/")) return {
      stdout: JSON.stringify({
        truncated: false,
        entries: [
          { path: "README.md", type: "blob", mode: "100644", sha: gitBlobSha(readme), size: Buffer.byteLength(readme) },
          { path: "dev-plan/implement.md", type: "blob", mode: "100644", sha: gitBlobSha(plan), size: Buffer.byteLength(plan) },
        ],
      }),
      stderr: "",
    };
    if (endpoint.includes("/git/blobs/")) {
      const sha = endpoint.split("/").at(-1);
      const content = blobs.get(sha);
      if (!content) throw new Error(`unknown blob ${sha}`);
      return {
        stdout: JSON.stringify({
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
          size: Buffer.byteLength(content),
          sha,
        }),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const engine = new GitHubSourceEngine(config, {
    execute,
    now: () => "2026-08-04T03:04:05.000Z",
  });
  const preview = await engine.preview(previewJob);
  const applyJob = {
    ...previewJob,
    id: "github-source:apply:test",
    idempotencyKey: "apply-abc123",
    kind: "apply",
    input: {
      ...previewJob.input,
      jobId: "github-source:apply:test",
      idempotencyKey: "apply-abc123",
      kind: "apply",
      manifestDigest: preview.preview.manifestDigest,
    },
  };
  const result = await engine.apply(applyJob);
  assert.equal(result.kind, "apply");
  assert.equal(result.applyPayload.documents.length, 2);
  assert.deepEqual(
    result.applyPayload.documents.map((document) => [document.path, document.content]),
    [["dev-plan/implement.md", plan], ["README.md", readme]],
  );
  assert.equal(result.applyPayload.preview.manifestDigest, preview.preview.manifestDigest);
  assert.deepEqual(result.applyPayload.reusedDocuments, []);
  assert.equal(result.applyPayload.documents.find((document) => document.path === "README.md").content.startsWith("\uFEFF"), true);
  assert.equal(calls.filter((args) => String(args[1]).includes("/git/blobs/")).length, 2);
  assert.ok(calls.every((args) => !String(args[1] ?? "").includes("raw.githubusercontent.com")));

  const readmeManifest = preview.preview.repositories[0].files.find((file) => file.path === "README.md");
  const callsBeforeReuse = calls.length;
  const reusedResult = await engine.apply({
    ...applyJob,
    input: {
      ...applyJob.input,
      reusableDocuments: [{
        repositoryId: readmeManifest.repositoryId,
        path: readmeManifest.path,
        blobSha: readmeManifest.blobSha,
        size: readmeManifest.size,
      }],
    },
  });
  const reuseCalls = calls.slice(callsBeforeReuse);
  assert.deepEqual(reusedResult.applyPayload.documents.map((document) => document.path), ["dev-plan/implement.md"]);
  assert.deepEqual(reusedResult.applyPayload.reusedDocuments.map((document) => document.path), ["README.md"]);
  assert.equal(reusedResult.summary.changedCount, 1);
  assert.equal(reusedResult.summary.unchangedCount, 1);
  assert.equal(reuseCalls.filter((args) => String(args[1]).includes("/git/blobs/")).length, 1);

  await assert.rejects(
    engine.apply({ ...applyJob, input: { ...applyJob.input, manifestDigest: "0".repeat(64) } }),
    /다시 미리보기/,
  );
});
