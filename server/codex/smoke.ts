import {
  buildEnrichmentJobInput,
  type EnrichmentJobRecord,
} from "../../app/lib/llm/enrichment-contracts.js";
import { CodexEnrichmentEngine } from "./codex-engine.js";
import { codexRuntimeConfig } from "../runtime/config.js";

const input = await buildEnrichmentJobInput({
  document: {
    id: "codex-smoke",
    name: "codex-smoke.md",
    hash: "codex-smoke-hash-v1",
    parserVersion: "smoke-v1",
  },
  providerVersion: codexRuntimeConfig.providerVersion,
  nodes: [
    { id: "node-rag", label: "RAG", shortLabel: "RAG", kind: "system", domain: "memory", summary: "검색 증강 생성", insight: "외부 근거를 사용합니다.", tags: ["rag"] },
    { id: "node-graph", label: "지식 그래프", shortLabel: "지식 그래프", kind: "system", domain: "memory", summary: "엔티티 관계 저장", insight: "관계형 탐색을 제공합니다.", tags: ["graph"] },
  ],
  existingRelations: [],
  blocks: [
    { id: "block:smoke:0", type: "paragraph", depth: 0, ordinal: 0, text: "RAG는 지식 그래프를 사용해 관련 근거를 탐색할 수 있습니다." },
  ],
});
const now = new Date().toISOString();
const job: EnrichmentJobRecord = {
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
  maxAttempts: 1,
  manualRetryCount: 0,
  leaseOwner: "smoke",
  leaseExpiresAt: new Date(Date.now() + codexRuntimeConfig.codexTimeoutMs + 60_000).toISOString(),
  createdAt: now,
  updatedAt: now,
};

const engine = new CodexEnrichmentEngine(codexRuntimeConfig);
await engine.checkAuthentication();
const result = await engine.enrich(job);
console.info(JSON.stringify({
  ok: true,
  status: result.status,
  relations: result.relations.length,
  warnings: result.warnings.length,
  usage: result.usage,
}));
