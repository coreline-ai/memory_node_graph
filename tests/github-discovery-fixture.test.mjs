import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import {
  createGitHubRepositoryFixture,
  createPagedGitHubFixtureLoader,
  manifestTreeFixture,
} from "./fixtures/github-discovery-fixture.mjs";

let modulesPromise;

async function discoveryModules() {
  modulesPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-github-discovery-test-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const discovery = (
      await readFile(new URL("../app/lib/github/discovery-contracts.ts", import.meta.url), "utf8")
    ).replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"');
    const manifest = (
      await readFile(new URL("../app/lib/github/repository-manifest.ts", import.meta.url), "utf8")
    )
      .replace('from "../ingestion/document-source.js"', 'from "./document-source.mjs"')
      .replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"')
      .replace('from "../markdown/validate-markdown.js"', 'from "./validate-markdown.mjs"')
      .replace('from "./discovery-contracts.js"', 'from "./discovery-contracts.mjs"');
    const documentSource = (
      await readFile(new URL("../app/lib/ingestion/document-source.ts", import.meta.url), "utf8")
    ).replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"');
    const [normalize, validateMarkdown] = await Promise.all([
      readFile(new URL("../app/lib/markdown/normalize.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/lib/markdown/validate-markdown.ts", import.meta.url), "utf8"),
    ]);
    await Promise.all([
      writeFile(join(directory, "discovery-contracts.mjs"), transpile(discovery)),
      writeFile(join(directory, "repository-manifest.mjs"), transpile(manifest)),
      writeFile(join(directory, "document-source.mjs"), transpile(documentSource)),
      writeFile(join(directory, "normalize.mjs"), transpile(normalize)),
      writeFile(join(directory, "validate-markdown.mjs"), transpile(validateMarkdown)),
    ]);
    const [contracts, manifests] = await Promise.all([
      import(pathToFileURL(join(directory, "discovery-contracts.mjs")).href),
      import(pathToFileURL(join(directory, "repository-manifest.mjs")).href),
    ]);
    return { contracts, manifests, cleanup: () => rm(directory, { recursive: true, force: true }) };
  })();
  return modulesPromise;
}

test("137개 fixture discovery는 고정 개수 없이 모든 page를 수집한다", async () => {
  const { contracts } = await discoveryModules();
  const fixtures = createGitHubRepositoryFixture(137);
  const loader = createPagedGitHubFixtureLoader(fixtures);
  const discovery = await contracts.collectGitHubRepositoryPages(loader.loadPage, { pageSize: 50 });

  assert.equal(discovery.owner, "coreline-ai");
  assert.equal(discovery.repositories.length, 137);
  assert.equal(discovery.pageCount, 3);
  assert.deepEqual(loader.requests.map((request) => request.cursor), [undefined, "50", "100"]);
  assert.ok(discovery.repositories.some((repository) => repository.visibility === "private"));
  assert.ok(discovery.repositories.some((repository) => repository.isTemplate));
  assert.ok(discovery.repositories.some((repository) => repository.isFork));
  assert.ok(discovery.repositories.some((repository) => repository.isArchived));
});

test("추천·사용자 선택·테스트 경고는 순서와 저장소 수에 관계없이 결정적이다", async () => {
  const { contracts } = await discoveryModules();
  const fixtures = createGitHubRepositoryFixture(137);
  const archived = fixtures.find((repository) => repository.isArchived);
  const ordinary = fixtures.find((repository) => !repository.isArchived && !repository.isFork && repository.name !== "knowledge-demo");
  const testLike = fixtures.find((repository) => repository.name === "knowledge-demo");
  const overrides = {
    [archived.repositoryId]: true,
    [ordinary.repositoryId]: false,
    "9999999": true,
  };
  const first = await contracts.resolveGitHubRepositorySelection(fixtures, overrides);
  const reordered = await contracts.resolveGitHubRepositorySelection([...fixtures].reverse(), overrides);

  assert.equal(first.selectionDigest, reordered.selectionDigest);
  assert.deepEqual(first.selectedRepositoryIds, reordered.selectedRepositoryIds);
  assert.deepEqual(first.unavailableSelectedRepositoryIds, ["9999999"]);
  assert.equal(first.items.find((item) => item.repositoryId === archived.repositoryId).syncEnabled, true);
  assert.equal(first.items.find((item) => item.repositoryId === ordinary.repositoryId).syncEnabled, false);
  const testItem = first.items.find((item) => item.repositoryId === testLike.repositoryId);
  assert.equal(testItem.warning, "test-like-name");
  assert.equal(testItem.recommended, true);
  assert.equal(testItem.syncEnabled, true);
  assert.ok(fixtures.some((repository) => repository.isPrivate &&
    first.items.find((item) => item.repositoryId === repository.repositoryId).recommended));
});

test("반복 cursor와 중복 repository ID는 discovery를 안전하게 중단한다", async () => {
  const { contracts } = await discoveryModules();
  const repository = createGitHubRepositoryFixture(1)[0];
  await assert.rejects(
    contracts.collectGitHubRepositoryPages(async () => ({
      repositories: [],
      hasNextPage: true,
      endCursor: "same-cursor",
    })),
    /cursor가 반복/,
  );
  let call = 0;
  await assert.rejects(
    contracts.collectGitHubRepositoryPages(async () => ({
      repositories: [repository],
      hasNextPage: call++ === 0,
      endCursor: call === 1 ? "next" : undefined,
    })),
    /중복 repositoryId/,
  );
});

test("manifest는 정확한 README와 dev-plan Markdown만 선택하고 truncated tree fallback을 사용한다", async () => {
  const { manifests } = await discoveryModules();
  const repository = createGitHubRepositoryFixture(1)[0];
  const input = {
    repository,
    commitSha: "a".repeat(40),
    ...manifestTreeFixture,
  };
  const first = await manifests.buildGitHubRepositoryManifest(input);
  const repeated = await manifests.buildGitHubRepositoryManifest(input);

  assert.equal(first.status, "ready");
  assert.equal(first.treeStrategy, "contents-fallback");
  assert.deepEqual(first.files.map((file) => file.path), [
    "dev-plan/archive/phase-0.md",
    "dev-plan/phase-1.md",
    "README.md",
  ]);
  assert.equal(first.digest, repeated.digest);
  assert.ok(first.files.every((file) => file.sourceKey.startsWith(`github:${repository.repositoryId}:`)));
  assert.ok(first.files.every((file) => file.sourceUrl.includes(`/blob/${"a".repeat(40)}/`)));
  assert.ok(first.files.every((file) => file.rawUrl.startsWith("https://raw.githubusercontent.com/")));
  const skipReasons = new Set(first.skipped.map((item) => item.reason));
  for (const reason of ["oversized", "symbolic_link", "submodule", "invalid_path", "invalid_blob_sha"]) {
    assert.ok(skipReasons.has(reason), reason);
  }
  assert.ok(!first.files.some((file) => file.path === "readme.md"));
  assert.ok(!first.files.some((file) => file.path === "dev-plan/uppercase.MD"));

  const blocked = await manifests.buildGitHubRepositoryManifest({
    repository,
    commitSha: "a".repeat(40),
    recursiveTree: { entries: [], truncated: true },
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReason, "tree_truncated_without_fallback");
});

test("dry-run은 create·update·delete·unchanged를 결정적으로 계산하고 blocked manifest에서 삭제하지 않는다", async () => {
  const { contracts, manifests } = await discoveryModules();
  const repository = createGitHubRepositoryFixture(1)[0];
  const manifest = await manifests.buildGitHubRepositoryManifest({
    repository,
    commitSha: "a".repeat(40),
    recursiveTree: {
      truncated: false,
      entries: [
        { path: "README.md", type: "blob", mode: "100644", sha: "b".repeat(40), size: 100 },
        { path: "dev-plan/phase.md", type: "blob", mode: "100644", sha: "c".repeat(40), size: 200 },
        { path: "dev-plan/new.md", type: "blob", mode: "100644", sha: "d".repeat(40), size: 300 },
      ],
    },
  });
  const currentDocuments = [
    {
      repositoryId: repository.repositoryId,
      sourceKey: `github:${repository.repositoryId}:README.md`,
      relativePath: "README.md",
      blobSha: "b".repeat(40),
    },
    {
      repositoryId: repository.repositoryId,
      sourceKey: `github:${repository.repositoryId}:dev-plan/phase.md`,
      relativePath: "dev-plan/phase.md",
      blobSha: "e".repeat(40),
    },
    {
      repositoryId: repository.repositoryId,
      sourceKey: `github:${repository.repositoryId}:dev-plan/removed.md`,
      relativePath: "dev-plan/removed.md",
      blobSha: "f".repeat(40),
    },
  ];
  const dryRun = manifests.buildGitHubRepositoryDryRun(manifest, currentDocuments);
  assert.deepEqual(dryRun.summary, {
    createCount: 1,
    updateCount: 1,
    deleteCount: 1,
    unchangedCount: 1,
  });
  assert.deepEqual(new Set(dryRun.actions.map((item) => item.action)),
    new Set(["create", "update", "delete", "unchanged"]));

  const selection = await contracts.resolveGitHubRepositorySelection(
    [repository],
    { [repository.repositoryId]: true },
  );
  const preview = await manifests.buildGitHubFixturePreview({
    selection,
    manifests: [manifest],
    currentDocuments,
  });
  const repeated = await manifests.buildGitHubFixturePreview({
    selection,
    manifests: [manifest],
    currentDocuments,
  });
  assert.equal(preview.status, "ready");
  assert.equal(preview.manifestDigest, repeated.manifestDigest);
  assert.deepEqual(preview.summary, dryRun.summary);

  const blockedManifest = await manifests.buildGitHubRepositoryManifest({
    repository,
    commitSha: "a".repeat(40),
    recursiveTree: { entries: [], truncated: true },
  });
  const blockedDryRun = manifests.buildGitHubRepositoryDryRun(blockedManifest, currentDocuments);
  assert.equal(blockedDryRun.status, "blocked");
  assert.deepEqual(blockedDryRun.actions, []);
  assert.deepEqual(blockedDryRun.summary, {
    createCount: 0,
    updateCount: 0,
    deleteCount: 0,
    unchangedCount: 0,
  });
});
