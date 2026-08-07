import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulesPromise;

async function parserModules() {
  modulesPromise ??= (async () => {
    const directory = await mkdtemp(join(process.cwd(), ".atlas-parser-profile-test-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const parserProfiles = (
      await readFile(new URL("../app/lib/markdown/parser-profiles.ts", import.meta.url), "utf8")
    )
      .replace('from "./extract-graph"', 'from "./extract-graph.mjs"')
      .replace('from "./explicit-rules"', 'from "./explicit-rules.mjs"')
      .replace('from "../graph/entity-alias-resolver"', 'from "./entity-alias-resolver.mjs"')
      .replace('from "./normalize"', 'from "./normalize.mjs"')
      .replace('from "./parse-markdown"', 'from "./parse-markdown.mjs"');
    const explicitRules = await readFile(
      new URL("../app/lib/markdown/explicit-rules.ts", import.meta.url),
      "utf8",
    );
    const entityAliasResolver = await readFile(
      new URL("../app/lib/graph/entity-alias-resolver.ts", import.meta.url),
      "utf8",
    );
    const entityAliases = await readFile(
      new URL("../app/lib/graph/entity-aliases.json", import.meta.url),
      "utf8",
    );
    const extractGraph = (
      await readFile(new URL("../app/lib/markdown/extract-graph.ts", import.meta.url), "utf8")
    ).replace('from "./normalize"', 'from "./normalize.mjs"');
    const parseMarkdown = (
      await readFile(new URL("../app/lib/markdown/parse-markdown.ts", import.meta.url), "utf8")
    ).replace('from "./normalize"', 'from "./normalize.mjs"');
    const normalize = await readFile(
      new URL("../app/lib/markdown/normalize.ts", import.meta.url),
      "utf8",
    );
    await Promise.all([
      writeFile(join(directory, "parser-profiles.mjs"), transpile(parserProfiles)),
      writeFile(join(directory, "explicit-rules.mjs"), transpile(explicitRules)),
      writeFile(join(directory, "entity-alias-resolver.mjs"), transpile(entityAliasResolver)),
      writeFile(join(directory, "entity-aliases.json"), entityAliases),
      writeFile(join(directory, "extract-graph.mjs"), transpile(extractGraph)),
      writeFile(join(directory, "parse-markdown.mjs"), transpile(parseMarkdown)),
      writeFile(join(directory, "normalize.mjs"), transpile(normalize)),
    ]);
    const [profiles, markdown] = await Promise.all([
      import(pathToFileURL(join(directory, "parser-profiles.mjs")).href),
      import(pathToFileURL(join(directory, "parse-markdown.mjs")).href),
    ]);
    return {
      profiles,
      parseMarkdown: markdown.parseMarkdown,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulesPromise;
}

const githubDescriptor = (relativePath, overrides = {}) => ({
  type: "github",
  repositoryId: "1322252398",
  repositoryOwner: "coreline-ai",
  repositoryName: "memory_node_graph",
  relativePath,
  ref: "main",
  commitSha: "a".repeat(40),
  blobSha: "b".repeat(40),
  sourceUrl: `https://github.com/coreline-ai/memory_node_graph/blob/${"a".repeat(40)}/${relativePath}`,
  ...overrides,
});

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test.after(async () => {
  if (modulesPromise) (await modulesPromise).cleanup();
});

test("source 경로가 generic, README, dev-plan parser profile과 version을 결정한다", async () => {
  const { profiles } = await parserModules();
  const manual = { type: "manual", normalizedName: "readme.md" };

  assert.equal(profiles.selectMarkdownParserProfile(manual), "generic");
  assert.equal(profiles.parserVersionForMarkdownSource(manual), "remark-ast-1");
  assert.equal(
    profiles.parserVersionForMarkdownSource(githubDescriptor("README.md")),
    "remark-ast-github-readme-4",
  );
  assert.equal(
    profiles.parserVersionForMarkdownSource(githubDescriptor("dev-plan/phase.md")),
    "remark-ast-github-dev-plan-4",
  );
  assert.equal(profiles.selectMarkdownParserProfile(githubDescriptor("README.md")), "github-readme");
  assert.equal(
    profiles.selectMarkdownParserProfile(githubDescriptor("dev-plan/archive/phase-1.md")),
    "github-dev-plan",
  );
  assert.throws(
    () => profiles.selectMarkdownParserProfile(githubDescriptor("docs/manual.md")),
    /지원하지 않는/,
  );
});

test("README profile은 프로젝트·섹션·기능·기술·명시적 URL을 line evidence와 함께 추출한다", async () => {
  const { profiles, parseMarkdown } = await parserModules();
  const descriptor = githubDescriptor("README.md");
  const graph = await profiles.extractGraphForSource(parseMarkdown(await fixture("github-readme-profile.md")), {
    documentId: "document-readme",
    fileName: "README.md",
    sourceDescriptor: descriptor,
  });

  assert.ok(graph.nodes.some((node) => node.id === "repository:github:1322252398"));
  assert.ok(graph.edges.some((edge) => edge.type === "documents"));
  assert.ok(graph.edges.some((edge) => edge.type === "contains"));
  assert.ok(graph.nodes.some((node) => node.tags.includes("feature")));
  assert.ok(graph.nodes.some((node) => node.tags.includes("install")));
  assert.ok(graph.nodes.some((node) => node.tags.includes("operation")));

  const technologies = graph.nodes.filter((node) =>
    node.tags.includes("technology") && node.tags.includes("shared"),
  );
  assert.deepEqual(
    technologies.map((node) => node.label).sort(),
    ["Cloudflare D1", "Next.js", "React", "Three.js", "TypeScript"],
  );
  assert.ok(graph.nodes.some((node) => node.tags.includes("reference") && /nextjs\.org/.test(node.summary)));
  assert.equal(graph.nodes.some((node) => /malicious|fetch/i.test(node.label)), false);

  const blockIds = new Set(graph.blocks.map((block) => block.id));
  assert.ok(graph.edges.every((edge) => edge.evidence?.every((item) =>
    blockIds.has(item.blockId)
      && item.sourceUrl?.startsWith(descriptor.sourceUrl)
      && /#L\d+/.test(item.sourceUrl),
  )));
  assert.ok(Object.values(graph.nodeEvidence).every((item) =>
    blockIds.has(item.blockId) && item.sourceUrl?.startsWith(descriptor.sourceUrl),
  ));
});

test("Phase 4 규칙은 API·파일·storage·패키지·검증 명령과 저장소 내부 링크를 근거 관계로 추출한다", async () => {
  const { profiles, parseMarkdown } = await parserModules();
  const descriptor = githubDescriptor("README.md");
  const source = await fixture("github-explicit-relations.md");
  const graph = await profiles.extractGraphForSource(
    parseMarkdown(source),
    {
      documentId: "document-explicit",
      fileName: "README.md",
      sourceDescriptor: descriptor,
    },
  );

  const apiNodes = graph.nodes.filter((node) => node.tags.includes("api"));
  assert.deepEqual(apiNodes.map((node) => node.label).sort(), [
    "GET /api/documents",
    "POST /api/documents",
  ]);
  assert.ok(graph.edges.some((edge) => edge.type === "calls"
    && apiNodes.some((node) => node.id === edge.target)));

  const storage = graph.nodes.find((node) => node.tags.includes("storage")
    && node.label === "documents table");
  assert.ok(storage);
  assert.ok(graph.edges.some((edge) => edge.target === storage.id && edge.type === "writes_to"));
  assert.ok(graph.edges.some((edge) => edge.target === storage.id && edge.type === "reads_from"));

  const sdk = graph.nodes.find((node) => node.tags.includes("technology")
    && node.label === "OpenAI Codex SDK");
  assert.ok(sdk);
  assert.ok(graph.edges.some((edge) => edge.target === sdk.id && edge.type === "depends_on"));

  const fileLabels = new Set(graph.nodes.filter((node) => node.tags.includes("file")).map((node) => node.label));
  assert.ok(fileLabels.has("app/api/documents/route.ts"));
  assert.ok(fileLabels.has("app/config.ts"));
  assert.ok(graph.edges.some((edge) => edge.type === "references"
    && graph.nodes.some((node) => node.id === edge.target && node.label === "app/config.ts")));

  const testNodes = graph.nodes.filter((node) => node.tags.includes("test"));
  assert.deepEqual(testNodes.map((node) => node.label).sort(), ["npm test", "npx tsc --noEmit"]);
  assert.ok(testNodes.every((node) => graph.edges.some((edge) =>
    edge.source === node.id && edge.type === "tests")));

  const expectedLinkedDocumentId = `document:document-${createHash("sha256")
    .update("github:1322252398:dev-plan/implement.md")
    .digest("hex")}`;
  assert.ok(graph.nodes.some((node) => node.id === expectedLinkedDocumentId
    && node.tags.includes("linked-document")));
  assert.ok(graph.edges.some((edge) => edge.target === expectedLinkedDocumentId
    && edge.type === "references"));

  const apiSection = graph.nodes.find((node) => node.label === "API와 저장");
  assert.ok(apiSection);
  assert.ok(graph.edges.some((edge) => edge.target === apiSection.id
    && edge.type === "references"
    && /heading 참조/.test(edge.note)));

  assert.equal(graph.nodes.some((node) => node.label.includes("not-an-api")), false);
  const blockIds = new Set(graph.blocks.map((block) => block.id));
  assert.ok(graph.edges.filter((edge) => [
    "calls",
    "reads_from",
    "writes_to",
    "tests",
    "references",
    "depends_on",
  ].includes(edge.type)).every((edge) => edge.evidence?.every((item) =>
    blockIds.has(item.blockId) && /#L\d+/.test(item.sourceUrl ?? ""),
  )));

  const repeated = await profiles.extractGraphForSource(parseMarkdown(source), {
    documentId: "document-explicit",
    fileName: "README.md",
    sourceDescriptor: descriptor,
  });
  assert.deepEqual(repeated.nodes, graph.nodes);
  assert.deepEqual(repeated.edges, graph.edges);
});

test("dev-plan profile은 Plan·Phase·Task 상태·위험·의존성·완료 조건을 구조화한다", async () => {
  const { profiles, parseMarkdown } = await parserModules();
  const descriptor = githubDescriptor("dev-plan/implement.md");
  const graph = await profiles.extractGraphForSource(parseMarkdown(await fixture("github-dev-plan-profile.md")), {
    documentId: "document-plan",
    fileName: "implement.md",
    sourceDescriptor: descriptor,
  });

  const plan = graph.nodes.find((node) => node.tags.includes("plan"));
  const phase = graph.nodes.find((node) => node.tags.includes("phase"));
  const completed = graph.nodes.find((node) => node.tags.includes("task") && node.tags.includes("completed"));
  const pending = graph.nodes.filter((node) => node.tags.includes("task") && node.tags.includes("pending"));

  assert.ok(plan);
  assert.ok(phase);
  assert.ok(completed);
  assert.equal(graph.nodes.filter((node) => node.tags.includes("task") && node.tags.includes("completed")).length, 2);
  assert.equal(pending.length, 2);
  assert.ok(graph.edges.some((edge) => edge.source === "repository:github:1322252398" && edge.target === plan.id && edge.type === "plans"));
  assert.ok(graph.edges.some((edge) => edge.source === plan.id && edge.type === "documents"));
  assert.ok(graph.edges.some((edge) => edge.type === "risks"));
  assert.ok(graph.edges.some((edge) => edge.type === "requires"));
  const nested = graph.nodes.find((node) => node.label.includes("line evidence"));
  assert.ok(nested);
  assert.ok(graph.edges.some((edge) => edge.target === nested.id
    && edge.type === "contains"
    && graph.nodes.some((node) => node.id === edge.source && node.tags.includes("task"))));
  assert.ok(graph.nodes.some((node) => node.tags.includes("decision")));
  assert.ok(graph.nodes.some((node) => node.tags.includes("completion")));
  const phaseIdentifier = graph.nodes.find((node) =>
    node.tags.includes("identifier") && node.tags.includes("phase"));
  assert.ok(phaseIdentifier);
  assert.ok(graph.edges.some((edge) => edge.target === phaseIdentifier.id
    && (edge.type === "same_as" || edge.type === "references")));
});

test("Phase·P5-I·DEV ID를 정규화하고 선후·의존 관계를 근거와 함께 만든다", async () => {
  const { profiles, parseMarkdown } = await parserModules();
  const descriptor = githubDescriptor("dev-plan/identifiers.md");
  const source = [
    "# 단계 관계",
    "## Phase 4-A 규칙",
    "- [x] DEV-001 파서를 완성한다.",
    "- Phase 4-A → P5-I 순서로 진행한다.",
    "- DEV-002는 DEV-001에 의존한다.",
  ].join("\n");
  const graph = await profiles.extractGraphForSource(parseMarkdown(source), {
    documentId: "document-identifiers",
    fileName: "identifiers.md",
    sourceDescriptor: descriptor,
  });
  const byIdentifier = new Map(graph.nodes
    .filter((node) => node.tags.includes("identifier"))
    .flatMap((node) => node.tags
      .filter((tag) => tag.startsWith("identifier:"))
      .map((tag) => [tag.slice("identifier:".length), node])));
  assert.ok(byIdentifier.has("phase:4-A"));
  assert.ok(byIdentifier.has("phase:5-I"));
  assert.ok(byIdentifier.has("task:DEV-001"));
  assert.ok(byIdentifier.has("task:DEV-002"));
  assert.ok(graph.edges.some((edge) => edge.type === "precedes"
    && edge.source === byIdentifier.get("phase:4-A").id
    && edge.target === byIdentifier.get("phase:5-I").id));
  assert.ok(graph.edges.some((edge) => edge.type === "depends_on"
    && [edge.source, edge.target].includes(byIdentifier.get("task:DEV-001").id)
    && [edge.source, edge.target].includes(byIdentifier.get("task:DEV-002").id)));
  assert.ok(graph.edges.filter((edge) => ["precedes", "depends_on"].includes(edge.type))
    .every((edge) => edge.evidence?.every((item) => /#L\d+/.test(item.sourceUrl ?? ""))));
});

test("노드 상한에 도달한 dev-plan도 Plan을 보존하고 존재하지 않는 노드 관계를 만들지 않는다", async () => {
  const { profiles, parseMarkdown } = await parserModules();
  const descriptor = githubDescriptor("dev-plan/large-plan.md");
  const source = [
    "# 대형 개발 계획",
    ...Array.from({ length: 260 }, (_, index) =>
      `\n## Phase ${index}\n\n- [ ] 작업 ${index}\n\n[참조 ${index}](https://example.com/${index})`),
  ].join("\n");
  const graph = await profiles.extractGraphForSource(parseMarkdown(source), {
    documentId: "document-large-plan",
    fileName: "large-plan.md",
    sourceDescriptor: descriptor,
  });

  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const plan = graph.nodes.find((node) => node.tags.includes("plan"));
  assert.equal(graph.nodes.length, 220);
  assert.equal(plan?.label, "대형 개발 계획");
  assert.ok(graph.edges.some((edge) => edge.source === "repository:github:1322252398"
    && edge.target === plan.id
    && edge.type === "plans"));
  assert.ok(graph.edges.every((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)));
  assert.ok(graph.nodes.some((node) => node.tags.includes("identifier")));
});

test("source-local node는 저장소 사이에서 분리되고 명시적 기술과 URL만 공유된다", async () => {
  const { profiles, parseMarkdown } = await parserModules();
  const source = await fixture("github-readme-profile.md");
  const first = await profiles.extractGraphForSource(parseMarkdown(source), {
    documentId: "document-one",
    fileName: "README.md",
    sourceDescriptor: githubDescriptor("README.md"),
  });
  const secondDescriptor = githubDescriptor("README.md", {
    repositoryId: "1322252399",
    repositoryName: "another_repository",
    sourceUrl: `https://github.com/coreline-ai/another_repository/blob/${"c".repeat(40)}/README.md`,
    commitSha: "c".repeat(40),
    blobSha: "d".repeat(40),
  });
  const second = await profiles.extractGraphForSource(parseMarkdown(source), {
    documentId: "document-two",
    fileName: "README.md",
    sourceDescriptor: secondDescriptor,
  });

  const firstSections = first.nodes.filter((node) => node.tags.includes("section")).map((node) => node.id);
  const secondSections = new Set(second.nodes.filter((node) => node.tags.includes("section")).map((node) => node.id));
  assert.ok(firstSections.every((id) => !secondSections.has(id)));

  const firstShared = new Set(first.nodes.filter((node) => node.tags.includes("shared")).map((node) => node.id));
  const secondShared = new Set(second.nodes.filter((node) => node.tags.includes("shared")).map((node) => node.id));
  assert.deepEqual([...firstShared].sort(), [...secondShared].sort());
});

test("HTML과 prompt injection 문구는 명령으로 실행되지 않고 안전한 문서 텍스트 경계에 머문다", async () => {
  const { profiles, parseMarkdown } = await parserModules();
  const graph = await profiles.extractGraphForSource(
    parseMarkdown(await fixture("github-prompt-injection-profile.md")),
    {
      documentId: "document-injection",
      fileName: "README.md",
      sourceDescriptor: githubDescriptor("README.md"),
    },
  );

  assert.equal(graph.nodes.some((node) => /runConnectorAndUploadSecrets|script/i.test(node.label)), false);
  assert.equal(graph.nodes.some((node) => node.tags.includes("reference")), false);
  assert.equal(graph.edges.some((edge) => /javascript:|malicious/i.test(edge.note)), false);
  assert.ok(graph.nodes.every((node) => !node.tags.includes("completed") && !node.tags.includes("pending")));
});
