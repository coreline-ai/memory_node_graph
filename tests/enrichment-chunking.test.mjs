import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

let modulesPromise;

async function modules() {
  modulesPromise ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "atlas-enrichment-chunking-"));
    const transpile = (source) => ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const contracts = (await readFile(
      new URL("../app/lib/llm/enrichment-contracts.ts", import.meta.url),
      "utf8",
    ))
      .replace('from "./relationship-candidate-score.js"', 'from "./relationship-candidate-score.mjs"')
      .replace('from "./semantic-anchor-resolver.js"', 'from "./semantic-anchor-resolver.mjs"');
    const score = (await readFile(
      new URL("../app/lib/llm/relationship-candidate-score.ts", import.meta.url),
      "utf8",
    )).replace('from "./semantic-anchor-resolver.js"', 'from "./semantic-anchor-resolver.mjs"');
    const resolver = await readFile(
      new URL("../app/lib/llm/semantic-anchor-resolver.ts", import.meta.url),
      "utf8",
    );
    const validator = (await readFile(
      new URL("../app/lib/llm/enrichment-result-validator.ts", import.meta.url),
      "utf8",
    ))
      .replace('from "./enrichment-contracts.js"', 'from "./enrichment-contracts.mjs"')
      .replace('from "./relationship-candidate-score.js"', 'from "./relationship-candidate-score.mjs"');
    await Promise.all([
      writeFile(join(directory, "enrichment-contracts.mjs"), transpile(contracts)),
      writeFile(join(directory, "relationship-candidate-score.mjs"), transpile(score)),
      writeFile(join(directory, "semantic-anchor-resolver.mjs"), transpile(resolver)),
      writeFile(join(directory, "enrichment-result-validator.mjs"), transpile(validator)),
    ]);
    const [contractModule, validatorModule] = await Promise.all([
      import(pathToFileURL(join(directory, "enrichment-contracts.mjs")).href),
      import(pathToFileURL(join(directory, "enrichment-result-validator.mjs")).href),
    ]);
    return {
      contracts: contractModule,
      validator: validatorModule,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  })();
  return modulesPromise;
}

test.after(async () => {
  if (modulesPromise) await (await modulesPromise).cleanup();
});

const node = (index, blockId) => ({
  id: `node-${index}`,
  label: `노드 ${index}`,
  shortLabel: `N${index}`,
  kind: "concept",
  domain: "memory",
  summary: "청크 검증",
  insight: "청크 근거",
  tags: [index === 0 ? "document" : "candidate"],
  blockId,
});

test("120개 초과 문서를 10~20 block 겹침 청크로 나누고 처음·중간·마지막을 모두 포함한다", async () => {
  const { contracts } = await modules();
  const blocks = Array.from({ length: 137 }, (_, ordinal) => ({
    id: `block:${ordinal}`,
    type: ordinal % 17 === 0 ? "heading" : "paragraph",
    depth: ordinal % 17 === 0 ? 2 : 0,
    text: `근거 블록 ${ordinal}`,
    ordinal,
  }));
  const nodes = blocks.map((block, index) => node(index, block.id));
  const nodeBlockIds = Object.fromEntries(nodes.map((item) => [item.id, item.blockId]));
  const input = {
    document: { id: "long-doc", name: "long.md", hash: "hash-long", parserVersion: "parser-v4" },
    providerVersion: "codex-sdk-test",
    nodes,
    nodeBlockIds,
    existingRelations: [],
    blocks,
  };
  const first = await contracts.buildEnrichmentJobInputs(input);
  const second = await contracts.buildEnrichmentJobInputs(input);

  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  assert.ok(first.every((job) => job.evidenceBlocks.length >= 10 && job.evidenceBlocks.length <= 20));
  const covered = new Set(first.flatMap((job) => job.evidenceBlocks.map((block) => block.ordinal)));
  assert.equal(covered.size, blocks.length);
  assert.ok(covered.has(0) && covered.has(68) && covered.has(136));
  assert.ok(first.every((job, index) => job.chunk.index === index && job.chunk.count === first.length));
  assert.equal(new Set(first.map((job) => job.idempotencyKey)).size, first.length);
  assert.ok(first.every((job) => job.nodes.every((candidate) =>
    candidate.tags.includes("document")
      || job.evidenceBlocks.some((block) => block.id === nodeBlockIds[candidate.id]))));
  assert.equal(contracts.estimateEvidenceChunkCount(blocks.length), first.length);
  for (const count of [0, 1, 10, 16, 17, 30, 31, 137, 2_001]) {
    const fixture = Array.from({ length: count }, (_, ordinal) => ({
      id: `estimate:${ordinal}`,
      type: "paragraph",
      depth: 0,
      text: `블록 ${ordinal}`,
      ordinal,
    }));
    assert.equal(
      contracts.estimateEvidenceChunkCount(count),
      Math.max(1, contracts.createEvidenceBlockChunks(fixture).length),
    );
  }
});

test("Codex 결과는 현재 청크에 없는 node·block을 mention과 관계에서 거부한다", async () => {
  const { contracts, validator } = await modules();
  const blocks = Array.from({ length: 24 }, (_, ordinal) => ({
    id: `block:${ordinal}`,
    type: "paragraph",
    depth: 0,
    text: `근거 ${ordinal}`,
    ordinal,
  }));
  const nodes = [node(0, blocks[0].id), node(1, blocks[1].id), node(2, blocks[23].id)];
  const [input] = await contracts.buildEnrichmentJobInputs({
    document: { id: "doc", name: "doc.md", hash: "hash", parserVersion: "parser-v4" },
    providerVersion: "codex-sdk-test",
    nodes,
    nodeBlockIds: Object.fromEntries(nodes.map((item) => [item.id, item.blockId])),
    existingRelations: [],
    blocks,
  });
  const now = new Date().toISOString();
  const job = {
    id: input.jobId,
    idempotencyKey: input.idempotencyKey,
    documentId: input.document.id,
    documentHash: input.document.hash,
    parserVersion: input.document.parserVersion,
    provider: input.provider,
    providerVersion: input.providerVersion,
    promptVersion: input.promptVersion,
    status: "running",
    input,
    attemptCount: 1,
    maxAttempts: 3,
    manualRetryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const validBlock = input.evidenceBlocks[0].id;
  const result = validator.validateEnrichmentResult({
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    documentHash: job.documentHash,
    provider: job.provider,
    providerVersion: job.providerVersion,
    promptVersion: job.promptVersion,
    status: "completed",
    entityMentions: [
      { nodeId: input.nodes[0].id, confidence: 0.9, evidence: [{ blockId: validBlock, explanation: "현재 청크" }] },
      { nodeId: "node-outside", confidence: 0.9, evidence: [{ blockId: "block:23", explanation: "다른 청크" }] },
    ],
    relations: [{
      source: input.nodes[0].id,
      target: input.nodes[1].id,
      type: "supports",
      confidence: 0.9,
      note: "현재 청크의 관계",
      evidence: [{ blockId: validBlock, explanation: "현재 청크" }],
    }],
    warnings: [],
  }, job);

  assert.equal(result.entityMentions.length, 1);
  assert.equal(result.relations.length, 1);
  assert.equal(result.status, "warning");
  assert.ok(result.warnings.some((warning) => /mention/.test(warning)));
});

test("구형 작업 입력이 구조 관계를 허용해도 Codex 결과로 contains를 저장하지 않는다", async () => {
  const { contracts, validator } = await modules();
  const blocks = [
    { id: "block:semantic:0", type: "paragraph", depth: 0, text: "Runtime uses D1.", ordinal: 0 },
  ];
  const [input] = await contracts.buildEnrichmentJobInputs({
    document: { id: "doc-semantic", name: "doc.md", hash: "hash", parserVersion: "parser-v4" },
    providerVersion: "codex-sdk-test",
    nodes: [node(0, blocks[0].id), node(1, blocks[0].id)],
    nodeBlockIds: { "node-0": blocks[0].id, "node-1": blocks[0].id },
    existingRelations: [],
    blocks,
  });
  // Simulate a queued job made by the old all-relation contract.
  input.constraints.allowedRelationTypes = ["contains", "supports"];
  const now = new Date().toISOString();
  const job = {
    id: input.jobId,
    idempotencyKey: input.idempotencyKey,
    documentId: input.document.id,
    documentHash: input.document.hash,
    parserVersion: input.document.parserVersion,
    provider: input.provider,
    providerVersion: input.providerVersion,
    promptVersion: input.promptVersion,
    status: "running",
    input,
    attemptCount: 1,
    maxAttempts: 3,
    manualRetryCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const result = validator.validateEnrichmentResult({
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    documentHash: job.documentHash,
    provider: job.provider,
    providerVersion: job.providerVersion,
    promptVersion: job.promptVersion,
    status: "completed",
    entityMentions: [],
    relations: [{
      source: input.nodes[0].id,
      target: input.nodes[1].id,
      type: "contains",
      confidence: 1,
      note: "구조 관계",
      evidence: [{ blockId: blocks[0].id, explanation: "문서 구조" }],
    }],
    warnings: [],
  }, job);
  assert.equal(result.relations.length, 0);
  assert.equal(result.status, "warning");
  assert.ok(result.warnings.some((warning) => /구조 관계/.test(warning)));
});
