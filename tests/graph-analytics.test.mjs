import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulePromise;
async function analyticsModule() {
  modulePromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-analytics-"));
    const source = await readFile(new URL("../app/lib/graph/analytics.ts", import.meta.url), "utf8");
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const file = join(directory, "analytics.mjs");
    await writeFile(file, output);
    return { module: await import(pathToFileURL(file).href), cleanup: () => rm(directory, { recursive: true, force: true }) };
  })();
  return modulePromise;
}

test.after(async () => {
  if (modulePromise) await (await modulePromise).cleanup();
});

const node = (id) => ({
  id, label: id, shortLabel: id, kind: "concept", domain: "memory",
  summary: id, insight: id, tags: [],
});

test("커뮤니티·중심성·품질 계산은 display 관계를 제외하고 결정적이다", async () => {
  const { module } = await analyticsModule();
  const snapshot = {
    nodes: ["a", "b", "c", "x", "y", "isolated"].map(node),
    edges: [
      { source: "a", target: "b", type: "contains", confidence: 1, note: "구조", layer: "structural" },
      { source: "b", target: "c", type: "supports", confidence: 0.95, note: "명시", layer: "explicit", evidence: [{ blockId: "1", explanation: "근거" }] },
      { source: "x", target: "y", type: "supports", confidence: 0.91, note: "추론", layer: "inferred", evidence: [{ blockId: "2", explanation: "근거" }] },
      { source: "c", target: "x", type: "related_to", confidence: 0.4, note: "화면", layer: "display" },
    ],
    meta: { source: "documents", provider: "markdown-ast", generatedAt: "2026-08-06T00:00:00Z" },
  };
  const first = module.analyzeGraphSnapshot(snapshot);
  const second = module.analyzeGraphSnapshot(snapshot);
  assert.deepEqual(first, second);
  assert.equal(first.meta.analytics.componentCount, 3);
  assert.equal(first.meta.analytics.inferredEvidenceCoverage, 1);
  assert.ok(first.meta.analytics.communityCount >= 3);
  assert.ok(first.nodes.every((candidate) => candidate.metrics));
  assert.ok(first.nodes.find((candidate) => candidate.id === "b").metrics.centrality > 0);
});

test("500노드·2000관계 규모 계산은 예산을 변경하지 않는다", async () => {
  const { module } = await analyticsModule();
  const nodes = Array.from({ length: 500 }, (_, index) => node(`n${index}`));
  const edges = Array.from({ length: 2_000 }, (_, index) => ({
    source: `n${index % 500}`,
    target: `n${(index * 17 + 11) % 500}`,
    type: "supports",
    confidence: 0.9,
    note: "fixture",
    layer: "explicit",
  })).filter((edge) => edge.source !== edge.target);
  const result = module.analyzeGraphSnapshot({
    nodes,
    edges,
    meta: { source: "demo", provider: "performance-fixture", generatedAt: "2026-08-06T00:00:00Z" },
  });
  assert.equal(result.nodes.length, 500);
  assert.equal(result.edges.length, edges.length);
  assert.ok(result.meta.analytics.communityCount > 0);
});
