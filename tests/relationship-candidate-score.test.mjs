import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulePromise;

async function scoreModule() {
  modulePromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-relationship-candidate-score-"));
    const source = await readFile(
      new URL("../app/lib/llm/relationship-candidate-score.ts", import.meta.url),
      "utf8",
    );
    const resolver = await readFile(
      new URL("../app/lib/llm/semantic-anchor-resolver.ts", import.meta.url),
      "utf8",
    );
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const resolverOutput = ts.transpileModule(resolver, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await writeFile(join(directory, "semantic-anchor-resolver.mjs"), resolverOutput);
    await writeFile(
      join(directory, "relationship-candidate-score.mjs"),
      output.replace('from "./semantic-anchor-resolver.js"', 'from "./semantic-anchor-resolver.mjs"'),
    );
    return {
      module: await import(pathToFileURL(join(directory, "relationship-candidate-score.mjs")).href),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulePromise;
}

test.after(async () => {
  if (modulePromise) await (await modulePromise).cleanup();
});

const node = (id, label, tags = ["component"]) => ({
  id,
  label,
  shortLabel: label,
  kind: "system",
  domain: "infrastructure",
  summary: `${label} 역할`,
  insight: "테스트",
  tags,
});

const job = ({ id = "job-a", text, nodes, existingRelations = [], type = "paragraph" }) => ({
  id,
  idempotencyKey: `${id}-key`,
  documentId: "document-a",
  documentHash: "hash-a",
  parserVersion: "parser-v1",
  provider: "codex",
  providerVersion: "codex-sdk-0.146.0+atlas-runtime.1",
  promptVersion: "atlas-relations-v3-anchors",
  status: "queued",
  attemptCount: 0,
  maxAttempts: 3,
  manualRetryCount: 0,
  createdAt: "2026-08-08T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  input: {
    jobId: id,
    idempotencyKey: `${id}-key`,
    document: { id: "document-a", name: "README.md", hash: "hash-a", parserVersion: "parser-v1" },
    provider: "codex",
    providerVersion: "codex-sdk-0.146.0+atlas-runtime.1",
    promptVersion: "atlas-relations-v3-anchors",
    ontologyVersion: "knowledge-graph-ontology-v1",
    chunk: { index: 0, count: 1, key: "chunk:1:1:0-0", startOrdinal: 0, endOrdinal: 0, overlapBefore: 0, overlapAfter: 0 },
    nodes,
    existingRelations,
    evidenceBlocks: [{ id: "block:1", type, depth: 0, text, ordinal: 1 }],
    constraints: { allowedRelationTypes: ["calls", "depends_on", "uses", "tests", "precedes"], maxCandidateRelations: 12, evidenceRequired: true },
  },
});

test("명시적인 semantic 관계와 양쪽 노드가 있는 청크만 high 후보가 된다", async () => {
  const { module } = await scoreModule();
  const candidate = module.scoreRelationshipCandidate(job({
    text: "Atlas Runtime calls Cloudflare D1 and writes validated graph relationships to Cloudflare D1 after the runtime completes.",
    nodes: [node("runtime", "Atlas Runtime"), node("d1", "Cloudflare D1")],
  }));
  assert.equal(candidate.tier, "high");
  assert.equal(candidate.expectedRelationType, "calls");
  assert.deepEqual(candidate.matchedNodeIds, ["d1", "runtime"]);
  assert.ok(candidate.positiveReasons.some((entry) => entry.code === "two_anchors"));
  assert.equal(candidate.sourceAnchor?.nodeId, "runtime");
  assert.equal(candidate.targetAnchor?.nodeId, "d1");
});

test("contains·문서 순서·목차·체크리스트는 보강 후보에서 제외한다", async () => {
  const { module } = await scoreModule();
  const nodes = [node("a", "Component A"), node("b", "Component B")];
  const fixtures = [
    job({ id: "contains", text: "Component A contains Component B.", nodes }),
    job({ id: "heading", text: "목표", nodes, type: "heading" }),
    job({ id: "links", text: "- [문서 A](https://example.com/a)\n- [문서 B](https://example.com/b)", nodes }),
    job({ id: "check", text: "- [ ] Component A uses Component B", nodes, type: "listItem" }),
    job({ id: "command", text: "Component A uses Component B after npm run verify runs.", nodes }),
    job({ id: "migration", text: "D1 schema uses drizzle/0002_codex_enrichment.sql migration SQL.", nodes }),
    job({ id: "order", text: "Section A precedes Section B.", nodes }),
  ];
  for (const fixture of fixtures) {
    assert.equal(module.scoreRelationshipCandidate(fixture).tier, "excluded", fixture.id);
  }
});

test("Phase·Task flow의 precedes만 high 후보가 되고 일반 문서 순서는 제외된다", async () => {
  const { module } = await scoreModule();
  const candidate = module.scoreRelationshipCandidate(job({
    id: "phase-flow",
    text: "Phase 1 -> Phase 2 순서로 실행하며 Phase 1 검증이 끝난 뒤 Phase 2를 시작합니다.",
    nodes: [node("phase-1", "Phase 1", ["phase", "workflow"]), node("phase-2", "Phase 2", ["phase", "workflow"])],
  }));
  assert.equal(candidate.expectedRelationType, "precedes");
  assert.equal(candidate.tier, "high");
});

test("기존 규칙 관계와 같은 semantic 관계는 high 후보가 될 수 없다", async () => {
  const { module } = await scoreModule();
  const nodes = [node("runtime", "Atlas Runtime"), node("d1", "Cloudflare D1")];
  const candidate = module.scoreRelationshipCandidate(job({
    id: "duplicate",
    text: "Atlas Runtime calls Cloudflare D1 and writes validated graph relationships to Cloudflare D1 after the runtime completes.",
    nodes,
    existingRelations: [{ source: "d1", target: "runtime", type: "calls", confidence: 1, note: "rule", origin: "rule" }],
  }));
  assert.equal(candidate.tier, "review");
  assert.ok(candidate.exclusionReasons.some((entry) => entry.code === "existing_relation"));
});

test("앵커 방향·해석 경계가 맞지 않으면 high가 아닌 review로 남는다", async () => {
  const { module } = await scoreModule();
  const reversed = module.scoreRelationshipCandidate(job({
    id: "reversed",
    text: "Cloudflare D1 calls Atlas Runtime.",
    nodes: [node("runtime", "Atlas Runtime"), node("d1", "Cloudflare D1", ["storage"])],
  }));
  assert.equal(reversed.tier, "review");
  assert.ok(reversed.exclusionReasons.some((entry) => entry.code === "direction_unresolved"));

  const unresolved = module.scoreRelationshipCandidate(job({
    id: "unresolved",
    text: "image_proxy calls research_proxy.",
    nodes: [node("image", "image_proxy")],
  }));
  assert.equal(unresolved.tier, "review");
  assert.ok(unresolved.exclusionReasons.some((entry) => entry.code === "unresolved_anchor"));
});

test("anchor audit은 순수 집계이며 후보 tier를 변경하지 않는다", async () => {
  const { module } = await scoreModule();
  const candidates = module.rankRelationshipCandidates([
    job({ text: "Atlas Runtime calls Research API.", nodes: [node("runtime", "Atlas Runtime"), node("api", "Research API", ["api"])] }),
    job({ id: "review", text: "image_proxy calls research_proxy.", nodes: [node("image", "image_proxy")] }),
  ]);
  const before = candidates.map((candidate) => candidate.tier);
  const audit = module.summarizeRelationshipCandidateAnchors(candidates);
  assert.equal(audit.candidatesWithAnchorPair, 1);
  assert.equal(audit.unresolvedAnchors, 1);
  assert.deepEqual(candidates.map((candidate) => candidate.tier), before);
});

test("점수 정렬과 high 선택은 입력 순서와 무관하며 10개·등급 경계를 강제한다", async () => {
  const { module } = await scoreModule();
  const highA = job({
    id: "high-a",
    text: "Atlas Runtime calls Cloudflare D1 and writes validated graph relationships to Cloudflare D1 after the runtime completes.",
    nodes: [node("runtime", "Atlas Runtime"), node("d1", "Cloudflare D1")],
  });
  const highB = job({
    id: "high-b",
    text: "Graph Worker depends_on Vector Store and tests Vector Store integration before release is approved.",
    nodes: [node("worker", "Graph Worker"), node("store", "Vector Store")],
  });
  const excluded = job({ id: "excluded", text: "목차", nodes: [node("a", "A node"), node("b", "B node")], type: "heading" });
  const first = module.rankRelationshipCandidates([highB, excluded, highA]);
  const second = module.rankRelationshipCandidates([highA, highB, excluded]);
  assert.deepEqual(first.map((item) => item.jobId), second.map((item) => item.jobId));
  const selection = module.selectHighRelationshipCandidates(first, ["high-b", "high-a"]);
  assert.deepEqual(selection.map((item) => item.jobId), first.filter((item) => item.tier === "high").map((item) => item.jobId));
  assert.throws(() => module.selectHighRelationshipCandidates(first, ["excluded"]), /high/);
  assert.throws(() => module.selectHighRelationshipCandidates(first, ["high-a", "high-a"]), /중복/);
  assert.throws(() => module.selectHighRelationshipCandidates(first, Array.from({ length: 11 }, (_, index) => `job-${index}`)), /1~10/);
});
