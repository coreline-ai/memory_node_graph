import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulePromise;

async function documentSourceModule() {
  modulePromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-document-source-test-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const source = (
      await readFile(
        new URL("../app/lib/ingestion/document-source.ts", import.meta.url),
        "utf8",
      )
    ).replace('from "../markdown/normalize.js"', 'from "./normalize.mjs"');
    const normalize = await readFile(
      new URL("../app/lib/markdown/normalize.ts", import.meta.url),
      "utf8",
    );

    await Promise.all([
      writeFile(join(directory, "document-source.mjs"), transpile(source)),
      writeFile(join(directory, "normalize.mjs"), transpile(normalize)),
    ]);
    const contracts = await import(pathToFileURL(join(directory, "document-source.mjs")).href);
    return { contracts, cleanup: () => rm(directory, { recursive: true, force: true }) };
  })();
  return modulePromise;
}

const githubSource = (overrides = {}) => ({
  repositoryId: "253600811",
  repositoryOwner: "coreline-ai",
  repositoryName: "memory_node_graph",
  relativePath: "README.md",
  ref: "main",
  commitSha: "a".repeat(40),
  blobSha: "b".repeat(40),
  sourceUrl: `https://github.com/coreline-ai/memory_node_graph/blob/${"a".repeat(40)}/README.md`,
  ...overrides,
});

test.after(async () => {
  if (modulePromise) (await modulePromise).cleanup();
});

test("manual source keys reuse the existing filename normalization contract", async () => {
  const { contracts } = await documentSourceModule();
  const descriptor = contracts.createManualDocumentSourceDescriptor("  README.MD  ");

  assert.deepEqual(descriptor, { type: "manual", normalizedName: "readme.md" });
  assert.equal(contracts.documentSourceKey(descriptor), "manual:readme.md");
  assert.throws(
    () => contracts.documentSourceKey({ type: "manual", normalizedName: "README.MD" }),
    /정규화된 값/,
  );
});

test("GitHub source keys isolate repositories and preserve case-sensitive paths", async () => {
  const { contracts } = await documentSourceModule();
  const first = contracts.createGitHubDocumentSourceDescriptor(githubSource());
  const secondRepository = contracts.createGitHubDocumentSourceDescriptor(
    githubSource({ repositoryId: "253600812" }),
  );
  const caseVariant = contracts.createGitHubDocumentSourceDescriptor(
    githubSource({ relativePath: "Readme.md" }),
  );

  assert.equal(contracts.documentSourceKey(first), "github:253600811:README.md");
  assert.equal(contracts.documentSourceKey(secondRepository), "github:253600812:README.md");
  assert.equal(contracts.documentSourceKey(caseVariant), "github:253600811:Readme.md");
  assert.notEqual(contracts.documentSourceKey(first), contracts.documentSourceKey(secondRepository));
  assert.notEqual(contracts.documentSourceKey(first), contracts.documentSourceKey(caseVariant));
});

test("repository renames and revisions do not change source identity", async () => {
  const { contracts } = await documentSourceModule();
  const original = contracts.createGitHubDocumentSourceDescriptor(githubSource());
  const revised = contracts.createGitHubDocumentSourceDescriptor(githubSource({
    repositoryName: "renamed-repository",
    ref: "next",
    commitSha: "c".repeat(40),
    blobSha: "d".repeat(40),
    sourceUrl: `https://github.com/coreline-ai/renamed-repository/blob/${"c".repeat(40)}/README.md`,
  }));

  assert.equal(contracts.documentSourceKey(original), contracts.documentSourceKey(revised));
  assert.equal(await contracts.documentIdForSource(original), await contracts.documentIdForSource(revised));
});

test("document IDs use the full SHA-256 digest of the source key", async () => {
  const { contracts } = await documentSourceModule();
  const sourceKey = "github:253600811:dev-plan/implement.md";
  const expected = createHash("sha256").update(sourceKey).digest("hex");

  assert.equal(
    await contracts.documentIdForSourceKey(sourceKey),
    `document-${expected}`,
  );
  assert.match(await contracts.documentIdForSourceKey(sourceKey), /^document-[0-9a-f]{64}$/);
});

test("GitHub descriptors reject ambiguous repository IDs and relative paths", async () => {
  const { contracts } = await documentSourceModule();

  assert.throws(
    () => contracts.createGitHubDocumentSourceDescriptor(githubSource({ repositoryId: "001" })),
    /repositoryId/,
  );
  for (const relativePath of ["/README.md", "dev-plan\\plan.md", "dev-plan/../README.md", "dev-plan//plan.md"]) {
    assert.throws(
      () => contracts.createGitHubDocumentSourceDescriptor(githubSource({ relativePath })),
      /relativePath/,
    );
  }
  assert.throws(
    () => contracts.createGitHubDocumentSourceDescriptor(githubSource({ sourceUrl: "http://github.com/coreline-ai/repo" })),
    /HTTPS/,
  );
});
