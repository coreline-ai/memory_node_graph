import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulePromise;

async function resolverModule() {
  modulePromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-semantic-anchor-resolver-"));
    const source = await readFile(
      new URL("../app/lib/llm/semantic-anchor-resolver.ts", import.meta.url),
      "utf8",
    );
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const file = join(directory, "semantic-anchor-resolver.mjs");
    await writeFile(file, output);
    return {
      resolver: await import(pathToFileURL(file).href),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulePromise;
}

test.after(async () => {
  if (modulePromise) await (await modulePromise).cleanup();
});

const node = (id, label, tags) => ({
  id,
  label,
  shortLabel: label,
  kind: "system",
  domain: "infrastructure",
  summary: `${label} 설명`,
  insight: "test",
  tags,
});

test("명시 component·API·file·package를 evidence-local node에 결정적으로 해석한다", async () => {
  const { resolver } = await resolverModule();
  const input = {
    nodes: [
      node("image", "image_proxy", ["component"]),
      node("route", "GET /v1/images", ["api"]),
      node("file", "app/image_proxy.ts", ["file"]),
      node("sdk", "OpenAI Codex SDK", ["technology", "shared"]),
      node("section", "구현 개요", ["section"]),
    ],
    blocks: [{
      id: "block:1",
      ordinal: 1,
      type: "paragraph",
      text: "image_proxy uses @openai/codex-sdk, calls GET /v1/images, and is implemented in app/image_proxy.ts.",
    }],
  };
  const first = resolver.resolveSemanticAnchors(input);
  const second = resolver.resolveSemanticAnchors({ nodes: [...input.nodes].reverse(), blocks: input.blocks });
  assert.deepEqual(first, second);
  assert.deepEqual(first.filter((anchor) => anchor.nodeId).map((anchor) => anchor.nodeId).sort(), [
    "file", "image", "route", "sdk",
  ]);
  assert.equal(first.find((anchor) => anchor.nodeId === "sdk")?.scope, "shared_technology");
  assert.equal(first.some((anchor) => anchor.nodeId === "section"), false);
});

test("일반 단어는 앵커가 아니며 미해결 강한 식별자는 review 근거로만 남긴다", async () => {
  const { resolver } = await resolverModule();
  const anchors = resolver.resolveSemanticAnchors({
    nodes: [node("generic", "목표", ["section"])],
    blocks: [{
      id: "block:2",
      ordinal: 2,
      type: "paragraph",
      text: "일반 proxy 결과를 설명합니다. research_proxy는 image_proxy를 호출합니다.",
    }],
  });
  assert.deepEqual(anchors.map((anchor) => [anchor.label, anchor.scope]).sort(), [
    ["image_proxy", "unresolved"],
    ["research_proxy", "unresolved"],
  ]);
  assert.equal(anchors.every((anchor) => !anchor.nodeId), true);
});
