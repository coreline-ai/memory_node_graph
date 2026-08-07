import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScript(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const loadJson = async (relativePath) =>
  JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));

test("ontology v1 Gold Graph is evidence-complete and respects semantic relation contracts", async () => {
  const [schema, fixture] = await Promise.all([
    importTypeScript("../app/lib/graph/gold-graph-schema.ts"),
    loadJson("./fixtures/knowledge-graph/gold-memory-node-graph.json"),
  ]);

  assert.deepEqual(schema.validateGoldGraphFixture(fixture), []);
  assert.equal(fixture.version, "1.0.0");
  assert.equal(fixture.ontologyVersion, "knowledge-graph-ontology-v1");
  assert.equal(fixture.readOnly, true);
  assert.equal(fixture.nodes.length, 68);
  assert.equal(fixture.edges.length, 101);
  assert.equal(new Set(fixture.nodes.map((node) => node.id)).size, fixture.nodes.length);
  assert.equal(new Set(fixture.edges.map((edge) => edge.id)).size, fixture.edges.length);

  const requiredTypes = [
    "project", "document", "component", "feature", "workflow", "api",
    "data", "storage", "technology", "decision", "risk", "test",
  ];
  const actualTypes = new Set(fixture.nodes.map((node) => node.type));
  requiredTypes.forEach((type) => assert.equal(actualTypes.has(type), true, type));

  const requiredRelations = [
    "implements", "depends_on", "calls", "reads_from", "writes_to",
    "produces", "tests", "precedes", "mitigates", "risks",
  ];
  const actualRelations = new Set(fixture.edges.map((edge) => edge.relation));
  requiredRelations.forEach((relation) => assert.equal(actualRelations.has(relation), true, relation));

  const nodeIds = new Set(fixture.nodes.map((node) => node.id));
  const connectedNodeIds = new Set(fixture.edges.flatMap((edge) => [edge.source, edge.target]));
  assert.deepEqual([...nodeIds].filter((id) => !connectedNodeIds.has(id)), []);
  assert.ok(
    fixture.edges.filter((edge) => edge.layer !== "structural").length >
      fixture.edges.filter((edge) => edge.layer === "structural").length * 3,
    "Gold Graph must be meaningfully richer than its structural spine",
  );

  const templateLabels = new Set([
    "구현 태스크", "자체 테스트", "목표", "완료 조건", "이슈 및 수정",
    "발견 이슈 없음", "QA 관점", "Phase 상태 요약",
  ]);
  assert.equal(fixture.nodes.some((node) => templateLabels.has(node.label)), false);

  const commitPath = `/${fixture.repository.owner}/${fixture.repository.name}/blob/${fixture.repository.commitSha}/`;
  for (const item of [...fixture.nodes, ...fixture.edges]) {
    assert.ok(item.evidence.length > 0, item.id);
    for (const evidence of item.evidence) {
      assert.match(evidence.blockId, new RegExp(`^block:${evidence.documentId}:-?\\d+$`));
      const url = new URL(evidence.sourceUrl);
      assert.equal(url.hostname, "github.com");
      assert.ok(url.pathname.startsWith(commitPath), evidence.sourceUrl);
      assert.match(url.hash, /^#L[1-9]\d*(?:-L[1-9]\d*)?$/);
    }
  }
});

test("Gold Graph validator rejects unsafe promotion, bad directions and weak inferred evidence", async () => {
  const [schema, fixture] = await Promise.all([
    importTypeScript("../app/lib/graph/gold-graph-schema.ts"),
    loadJson("./fixtures/knowledge-graph/gold-memory-node-graph.json"),
  ]);

  const clone = structuredClone(fixture);
  clone.nodes[0].label = "구현 태스크";
  clone.edges[0].source = clone.edges[0].target;
  clone.edges.find((edge) => edge.layer === "inferred").evidence.length = 1;
  clone.edges[10].relation = "calls";
  clone.edges[10].confidence = 0.2;
  const issues = schema.validateGoldGraphFixture(clone);

  assert.ok(issues.some((issue) => /template heading/.test(issue)));
  assert.ok(issues.some((issue) => /self relation/.test(issue)));
  assert.ok(issues.some((issue) => /two independent blocks/.test(issue)));
  assert.ok(issues.some((issue) => /source-target pattern|relation minimum|confidence is invalid/.test(issue)));
});

test("confirmed aliases remain narrow and protect ambiguous product names", async () => {
  const aliases = await loadJson("../app/lib/graph/entity-aliases.json");
  const byId = new Map(aliases.canonicalEntities.map((entry) => [entry.canonicalId, entry]));
  assert.deepEqual(
    byId.get("technology:openai-codex-sdk").aliases,
    ["Codex SDK", "공식 Codex SDK", "@openai/codex-sdk"],
  );
  assert.deepEqual(byId.get("technology:github-cli").aliases, ["gh"]);
  assert.ok(aliases.protectedAmbiguities.some((entry) => entry.token === "Codex"));
  assert.ok(aliases.protectedAmbiguities.some((entry) => entry.token === "GitHub"));
  assert.ok(aliases.excludedTemplateLabels.includes("QA 관점"));
});
