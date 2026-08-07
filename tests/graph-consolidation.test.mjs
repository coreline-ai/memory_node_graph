import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

let modulePromise;

async function consolidationModule() {
  modulePromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-consolidation-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const consolidation = (await readFile(
      new URL("../app/lib/graph/consolidation.ts", import.meta.url), "utf8",
    )).replace('from "./entity-alias-resolver"', 'from "./entity-alias-resolver.mjs"');
    const resolver = await readFile(
      new URL("../app/lib/graph/entity-alias-resolver.ts", import.meta.url), "utf8",
    );
    const catalog = await readFile(
      new URL("../app/lib/graph/entity-aliases.json", import.meta.url), "utf8",
    );
    await Promise.all([
      writeFile(join(directory, "consolidation.mjs"), transpile(consolidation)),
      writeFile(join(directory, "entity-alias-resolver.mjs"), transpile(resolver)),
      writeFile(join(directory, "entity-aliases.json"), catalog),
    ]);
    return {
      module: await import(pathToFileURL(join(directory, "consolidation.mjs")).href),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulePromise;
}

test.after(async () => {
  if (modulePromise) await (await modulePromise).cleanup();
});

const node = (id, label, tags) => ({
  id, label, shortLabel: label, kind: "concept", domain: "memory",
  summary: label, insight: label, tags,
});

test("확인된 별칭만 canonical entity에 연결하고 문서 mention을 교차 문서 허브로 만든다", async () => {
  const { module } = await consolidationModule();
  const snapshot = {
    nodes: [
      node("document:a", "README.md", ["document"]),
      node("section:a", "기술", ["section"]),
      node("legacy-sdk", "Codex SDK", ["technology"]),
      node("document:b", "plan.md", ["document"]),
      node("section:b", "의존성", ["section"]),
      node("ambiguous", "Codex", ["technology"]),
    ],
    edges: [
      { source: "document:a", target: "section:a", type: "contains", confidence: 1, note: "구조", layer: "structural" },
      { source: "section:a", target: "legacy-sdk", type: "uses", confidence: 0.96, note: "명시", layer: "explicit", evidence: [{ blockId: "a:1", explanation: "Codex SDK", sourceUrl: "https://example.test/a#L1" }] },
      { source: "document:b", target: "section:b", type: "contains", confidence: 1, note: "구조", layer: "structural" },
      { source: "section:b", target: "legacy-sdk", type: "requires", confidence: 0.94, note: "명시", layer: "explicit", evidence: [{ blockId: "b:1", explanation: "Codex SDK", sourceUrl: "https://example.test/b#L1" }] },
    ],
    meta: { source: "documents", provider: "markdown-ast", generatedAt: "2026-08-06T00:00:00Z" },
  };
  const first = module.consolidateGraphSnapshot(snapshot);
  const second = module.consolidateGraphSnapshot(snapshot);
  assert.deepEqual(first, second);
  assert.ok(first.nodes.some((candidate) => candidate.id === "technology:openai-codex-sdk"));
  assert.ok(first.edges.some((edge) => edge.source === "legacy-sdk"
    && edge.target === "technology:openai-codex-sdk" && edge.type === "same_as"));
  assert.equal(first.edges.filter((edge) => edge.type === "mentions"
    && edge.target === "legacy-sdk").length, 2);
  assert.equal(first.edges.some((edge) => edge.source === "ambiguous" && edge.type === "same_as"), false);
  assert.ok(first.edges.filter((edge) => edge.type === "mentions").every((edge) => edge.evidence?.length));
});
