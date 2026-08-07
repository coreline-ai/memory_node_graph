import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulePromise;

async function rulesModule() {
  modulePromise ??= (async () => {
    const directory = await mkdtemp(join(process.cwd(), ".atlas-explicit-rules-test-"));
    const source = await readFile(
      new URL("../app/lib/markdown/explicit-rules.ts", import.meta.url),
      "utf8",
    );
    const output = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const file = join(directory, "explicit-rules.mjs");
    await writeFile(file, output);
    return {
      rules: await import(pathToFileURL(file).href),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulePromise;
}

test.after(async () => {
  if (modulePromise) (await modulePromise).cleanup();
});

test("저장소 내부 Markdown·heading·파일 링크를 정규화하고 외부·탈출 경로는 분리한다", async () => {
  const { rules } = await rulesModule();

  assert.deepEqual(rules.resolveRepositoryMarkdownLink("#설치 방법", "README.md"), {
    kind: "anchor",
    relativePath: "README.md",
    anchor: "설치-방법",
  });
  assert.deepEqual(rules.resolveRepositoryMarkdownLink(
    "dev-plan/implement.md#phase-1",
    "README.md",
  ), {
    kind: "document",
    relativePath: "dev-plan/implement.md",
    anchor: "phase-1",
  });
  assert.deepEqual(rules.resolveRepositoryMarkdownLink("../README.md", "dev-plan/current.md"), {
    kind: "document",
    relativePath: "README.md",
  });
  assert.deepEqual(rules.resolveRepositoryMarkdownLink("./app/config.ts", "README.md"), {
    kind: "file",
    relativePath: "app/config.ts",
  });
  assert.equal(rules.resolveRepositoryMarkdownLink("../../secret.md", "dev-plan/current.md"), null);
  assert.equal(rules.resolveRepositoryMarkdownLink("https://example.com/doc.md", "README.md"), null);
  assert.equal(rules.resolveRepositoryMarkdownLink("javascript:alert(1)", "README.md"), null);
});

test("명시 규칙은 API·파일·table·package·검증 명령을 결정적으로 중복 제거한다", async () => {
  const { rules } = await rulesModule();
  const source = [
    "POST /api/jobs",
    "POST /api/jobs",
    "SELECT * FROM jobs",
    "app/api/jobs/route.ts",
    "npm install @openai/codex-sdk zod@3",
    "npm test",
    "npx tsc --noEmit",
  ].join("\n");

  const first = rules.explicitEntitiesIn(source, { codeBlock: true });
  const second = rules.explicitEntitiesIn(source, { codeBlock: true });
  assert.deepEqual(first, second);
  assert.equal(first.filter((candidate) => candidate.label === "POST /api/jobs").length, 1);
  assert.ok(first.some((candidate) => candidate.semanticType === "storage"
    && candidate.label === "jobs table"
    && candidate.relation === "reads_from"));
  assert.ok(first.some((candidate) => candidate.semanticType === "file"
    && candidate.label === "app/api/jobs/route.ts"));
  assert.ok(first.some((candidate) => candidate.semanticType === "technology"
    && candidate.label === "@openai/codex-sdk"
    && candidate.relation === "depends_on"));
  assert.ok(first.some((candidate) => candidate.semanticType === "technology"
    && candidate.label === "zod"
    && candidate.relation === "depends_on"));
  assert.deepEqual(
    first.filter((candidate) => candidate.semanticType === "test").map((candidate) => candidate.label),
    ["npm test", "npx tsc --noEmit"],
  );
});

test("예시 payload·일반 경로 문자열·명령이 아닌 문장은 전문 엔티티로 승격하지 않는다", async () => {
  const { rules } = await rulesModule();
  assert.deepEqual(
    rules.explicitEntitiesIn('{"path":"/not-an-api","email":"user@example.com"}'),
    [],
  );
  assert.deepEqual(rules.explicitEntitiesIn("fetch 데이터를 설명하지만 명령을 실행하지 않습니다."), []);
});

test("Phase·P·DEV 식별자와 명시 관계를 결정적으로 정규화한다", async () => {
  const { rules } = await rulesModule();
  assert.deepEqual(rules.explicitIdentifiersIn("Phase 4-A → P5-I, DEV-001 이후 DEV-002"), [
    { kind: "phase", key: "phase:4-A", label: "Phase 4-A", raw: "Phase 4-A" },
    { kind: "phase", key: "phase:5-I", label: "P5-I", raw: "P5-I" },
    { kind: "task", key: "task:DEV-001", label: "DEV-001", raw: "DEV-001" },
    { kind: "task", key: "task:DEV-002", label: "DEV-002", raw: "DEV-002" },
  ]);
  assert.deepEqual(
    rules.explicitIdentifierRelationsIn("Phase 4-A → P5-I"),
    [{ sourceKey: "phase:4-A", targetKey: "phase:5-I", relation: "precedes", confidence: 0.96 }],
  );
  assert.deepEqual(
    rules.explicitIdentifierRelationsIn("DEV-002는 DEV-001에 의존한다."),
    [{ sourceKey: "task:DEV-002", targetKey: "task:DEV-001", relation: "depends_on", confidence: 0.95 }],
  );
});
