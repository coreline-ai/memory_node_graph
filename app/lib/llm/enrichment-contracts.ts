import type { KnowledgeEdge, KnowledgeNode, RelationKind } from "../../graph-data";
import type { DocumentBlock } from "../markdown/extract-graph";
import { CODEX_SEMANTIC_RELATION_TYPES } from "./relationship-candidate-score.js";
import {
  resolveSemanticAnchors,
  type SemanticAnchor,
} from "./semantic-anchor-resolver.js";

export const ENRICHMENT_PROVIDER = "codex" as const;
export const ENRICHMENT_PROMPT_VERSION = "atlas-relations-v3-anchors";
export const ENRICHMENT_ONTOLOGY_VERSION = "knowledge-graph-ontology-v1";

export const ENRICHMENT_INPUT_LIMITS = Object.freeze({
  maxNodes: 220,
  maxExistingRelations: 540,
  maxEvidenceBlocks: 120,
  maxEvidenceBlockCharacters: 1_200,
  maxEvidenceCharacters: 48_000,
  maxCandidateRelations: 96,
  evidenceBlocksPerChunk: 16,
  evidenceBlockOverlap: 2,
});

export const ENRICHMENT_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "completed",
  "warning",
  "failed",
  "stale",
  "cancelled",
] as const;

export type EnrichmentJobStatus = (typeof ENRICHMENT_JOB_STATUSES)[number];

export const ENRICHMENT_ERROR_CODES = [
  "runtime_auth_required",
  "runtime_unavailable",
  "lease_conflict",
  "lease_expired",
  "document_stale",
  "invalid_input",
  "invalid_result",
  "provider_error",
  "provider_timeout",
  "cancelled",
  "retry_exhausted",
  "unknown",
] as const;

export type EnrichmentErrorCode = (typeof ENRICHMENT_ERROR_CODES)[number];

export type EnrichmentEvidenceBlock = {
  id: string;
  type: string;
  depth: number;
  text: string;
  ordinal: number;
};

export type RelationEvidence = {
  blockId: string;
  explanation: string;
};

export type EnrichmentRelationCandidate = {
  source: string;
  target: string;
  type: RelationKind;
  confidence: number;
  note: string;
  evidence: RelationEvidence[];
};

export type EnrichmentEntityMentionCandidate = {
  nodeId: string;
  confidence: number;
  evidence: RelationEvidence[];
};

export type EnrichmentChunkDescriptor = {
  index: number;
  count: number;
  key: string;
  startOrdinal: number;
  endOrdinal: number;
  overlapBefore: number;
  overlapAfter: number;
};

export type EnrichmentJobInput = {
  jobId: string;
  idempotencyKey: string;
  document: {
    id: string;
    name: string;
    hash: string;
    parserVersion: string;
  };
  provider: typeof ENRICHMENT_PROVIDER;
  providerVersion: string;
  promptVersion: string;
  ontologyVersion: string;
  chunk: EnrichmentChunkDescriptor;
  nodes: KnowledgeNode[];
  /** Evidence-local anchors are advisory context for relation review. */
  anchors?: SemanticAnchor[];
  existingRelations: KnowledgeEdge[];
  evidenceBlocks: EnrichmentEvidenceBlock[];
  constraints: {
    allowedRelationTypes: RelationKind[];
    maxCandidateRelations: number;
    evidenceRequired: true;
  };
};

export type EnrichmentResult = {
  jobId: string;
  idempotencyKey: string;
  documentHash: string;
  provider: typeof ENRICHMENT_PROVIDER;
  providerVersion: string;
  promptVersion: string;
  status: "completed" | "warning";
  entityMentions: EnrichmentEntityMentionCandidate[];
  relations: EnrichmentRelationCandidate[];
  warnings: string[];
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
};

export type EnrichmentJobRecord = {
  id: string;
  idempotencyKey: string;
  documentId: string;
  documentHash: string;
  parserVersion: string;
  provider: typeof ENRICHMENT_PROVIDER;
  providerVersion: string;
  promptVersion: string;
  status: EnrichmentJobStatus;
  input: EnrichmentJobInput;
  result?: EnrichmentResult;
  attemptCount: number;
  maxAttempts: number;
  manualRetryCount: number;
  lastManualRetryAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: EnrichmentErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export const RUNTIME_STATUS_KINDS = ["online", "offline"] as const;
export type RuntimeStatusKind = (typeof RUNTIME_STATUS_KINDS)[number];

export const RUNTIME_RUN_MODES = ["continuous", "bounded"] as const;
export type RuntimeRunMode = (typeof RUNTIME_RUN_MODES)[number];

export const RUNTIME_RUN_STOP_REASONS = [
  "dry_run",
  "job_limit",
  "runtime_limit",
  "idle",
  "once",
  "signal",
  "fatal",
] as const;
export type RuntimeRunStopReason = (typeof RUNTIME_RUN_STOP_REASONS)[number];

export type RuntimeRunTelemetry = {
  runMode?: RuntimeRunMode;
  maxJobs?: number;
  maxRuntimeMs?: number;
  processedJobs?: number;
  succeededJobs?: number;
  warningJobs?: number;
  failedJobs?: number;
  stopReason?: RuntimeRunStopReason;
};

export const CODEX_RUNTIME_STATES = [
  "connected",
  "login_required",
  "reauth_required",
  "running",
  "failed",
] as const;
export type CodexRuntimeState = (typeof CODEX_RUNTIME_STATES)[number];

export type RuntimeStatusRecord = RuntimeRunTelemetry & {
  runtimeId: string;
  status: RuntimeStatusKind;
  version: string;
  runtimeState?: CodexRuntimeState;
  runtimeMessage?: string;
  currentJobId?: string;
  startedAt: string;
  lastSeenAt: string;
};

export const ENRICHMENT_STATUS_TRANSITIONS: Readonly<
  Record<EnrichmentJobStatus, readonly EnrichmentJobStatus[]>
> = Object.freeze({
  queued: ["leased", "cancelled", "stale"],
  leased: ["leased", "running", "queued", "completed", "warning", "failed", "cancelled", "stale"],
  running: ["leased", "queued", "completed", "warning", "failed", "cancelled", "stale"],
  completed: ["stale"],
  warning: ["queued", "stale"],
  failed: ["queued"],
  stale: [],
  cancelled: [],
});

export const canTransitionEnrichmentJob = (
  from: EnrichmentJobStatus,
  to: EnrichmentJobStatus,
) => ENRICHMENT_STATUS_TRANSITIONS[from].includes(to);

const cleanText = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();

export function serializeEvidenceBlocks(
  blocks: DocumentBlock[],
  limits = ENRICHMENT_INPUT_LIMITS,
): EnrichmentEvidenceBlock[] {
  let remainingCharacters = limits.maxEvidenceCharacters;
  const serialized: EnrichmentEvidenceBlock[] = [];

  for (const block of [...blocks].sort((a, b) => a.ordinal - b.ordinal)) {
    if (serialized.length >= limits.maxEvidenceBlocks || remainingCharacters <= 0) break;
    const normalized = cleanText(block.text);
    if (!normalized) continue;
    const text = normalized.slice(
      0,
      Math.min(limits.maxEvidenceBlockCharacters, remainingCharacters),
    );
    if (!text) break;
    serialized.push({
      id: block.id,
      type: block.type,
      depth: block.depth,
      text,
      ordinal: block.ordinal,
    });
    remainingCharacters -= text.length;
  }

  return serialized;
}

export async function createEnrichmentIdempotencyKey(input: {
  documentHash: string;
  parserVersion: string;
  promptVersion: string;
  providerVersion: string;
  ontologyVersion?: string;
  chunkKey?: string;
  reprocessNonce?: string;
}) {
  const canonicalParts = [
    input.documentHash,
    input.parserVersion,
    input.promptVersion,
    input.providerVersion,
    input.ontologyVersion ?? ENRICHMENT_ONTOLOGY_VERSION,
    input.chunkKey ?? "chunk:0:1",
  ];
  if (input.reprocessNonce) canonicalParts.push(input.reprocessNonce);
  const canonical = JSON.stringify(canonicalParts);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

// Hierarchy, aliases and mentions are deterministic Markdown-parser output.
// Codex gets only semantic relation types, which prevents a selected batch
// from spending its result budget on contains/documents/plans edges.
const relationTypes: RelationKind[] = [...CODEX_SEMANTIC_RELATION_TYPES];

export type CodexEnrichmentOutput = {
  entityMentions: EnrichmentEntityMentionCandidate[];
  relations: EnrichmentRelationCandidate[];
  warnings: string[];
};

export const ENRICHMENT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["entityMentions", "relations", "warnings"],
  properties: {
    entityMentions: {
      type: "array",
      maxItems: ENRICHMENT_INPUT_LIMITS.maxNodes,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nodeId", "confidence", "evidence"],
        properties: {
          nodeId: { type: "string", minLength: 1, maxLength: 240 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["blockId", "explanation"],
              properties: {
                blockId: { type: "string", minLength: 1, maxLength: 240 },
                explanation: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
          },
        },
      },
    },
    relations: {
      type: "array",
      maxItems: ENRICHMENT_INPUT_LIMITS.maxCandidateRelations,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "type", "confidence", "note", "evidence"],
        properties: {
          source: { type: "string", minLength: 1, maxLength: 240 },
          target: { type: "string", minLength: 1, maxLength: 240 },
          type: { type: "string", enum: relationTypes },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          note: { type: "string", minLength: 1, maxLength: 500 },
          evidence: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["blockId", "explanation"],
              properties: {
                blockId: { type: "string", minLength: 1, maxLength: 240 },
                explanation: { type: "string", minLength: 1, maxLength: 500 },
              },
            },
          },
        },
      },
    },
    warnings: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 500 },
    },
  },
});

export type BuildEnrichmentJobInput = {
  jobId?: string;
  reprocessNonce?: string;
  document: EnrichmentJobInput["document"];
  providerVersion: string;
  promptVersion?: string;
  nodes: KnowledgeNode[];
  existingRelations: KnowledgeEdge[];
  blocks: DocumentBlock[];
  nodeBlockIds?: Record<string, string>;
  ontologyVersion?: string;
  chunkSize?: number;
  chunkOverlap?: number;
};

export function createEvidenceBlockChunks(
  blocks: DocumentBlock[],
  options: { size?: number; overlap?: number } = {},
) {
  const normalized = [...blocks]
    .filter((block) => cleanText(block.text))
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const size = Math.max(
    10,
    Math.min(20, Math.floor(options.size ?? ENRICHMENT_INPUT_LIMITS.evidenceBlocksPerChunk)),
  );
  const overlap = Math.max(
    0,
    Math.min(size - 1, Math.floor(options.overlap ?? ENRICHMENT_INPUT_LIMITS.evidenceBlockOverlap)),
  );
  if (!normalized.length) return [] as DocumentBlock[][];
  const chunks: DocumentBlock[][] = [];
  const step = size - overlap;
  for (let start = 0; start < normalized.length; start += step) {
    const finalStart = start + size >= normalized.length
      ? Math.max(0, normalized.length - size)
      : start;
    const chunk = normalized.slice(finalStart, finalStart + size);
    if (!chunk.length) break;
    if (chunks.at(-1)?.at(0)?.id === chunk[0]?.id) break;
    chunks.push(chunk);
    if (finalStart + size >= normalized.length) break;
  }
  return chunks;
}

/**
 * Returns the exact number of chunks produced by createEvidenceBlockChunks
 * without materializing document text. This is used by the dashboard preview
 * before a repository-wide reprocess is started.
 */
export function estimateEvidenceChunkCount(
  evidenceBlockCount: number,
  options: { size?: number; overlap?: number } = {},
) {
  const count = Math.max(0, Math.floor(evidenceBlockCount));
  if (count === 0) return 1;
  const size = Math.max(
    10,
    Math.min(20, Math.floor(options.size ?? ENRICHMENT_INPUT_LIMITS.evidenceBlocksPerChunk)),
  );
  const overlap = Math.max(
    0,
    Math.min(size - 1, Math.floor(options.overlap ?? ENRICHMENT_INPUT_LIMITS.evidenceBlockOverlap)),
  );
  if (count <= size) return 1;
  return 1 + Math.ceil((count - size) / (size - overlap));
}

const selectNodesForChunk = (
  nodes: KnowledgeNode[],
  nodeBlockIds: Record<string, string> | undefined,
  chunkBlockIds: Set<string>,
  anchorNodeIds: ReadonlySet<string>,
) => {
  const included = nodeBlockIds
    ? nodes.filter((node) =>
      chunkBlockIds.has(nodeBlockIds[node.id])
      || anchorNodeIds.has(node.id)
      || node.tags.some((tag) => ["repository", "document", "plan", "shared"].includes(tag)))
    : nodes;
  return included.sort((left, right) => {
    const leftAnchor = anchorNodeIds.has(left.id) ? 1 : 0;
    const rightAnchor = anchorNodeIds.has(right.id) ? 1 : 0;
    const leftLocal = nodeBlockIds && chunkBlockIds.has(nodeBlockIds[left.id]) ? 1 : 0;
    const rightLocal = nodeBlockIds && chunkBlockIds.has(nodeBlockIds[right.id]) ? 1 : 0;
    const leftContext = left.tags.some((tag) => ["repository", "document", "plan", "shared"].includes(tag)) ? 1 : 0;
    const rightContext = right.tags.some((tag) => ["repository", "document", "plan", "shared"].includes(tag)) ? 1 : 0;
    return rightAnchor - leftAnchor
      || rightLocal - leftLocal
      || leftContext - rightContext
      || left.id.localeCompare(right.id);
  }).slice(0, ENRICHMENT_INPUT_LIMITS.maxNodes);
};

const serializeSemanticAnchors = (anchors: readonly SemanticAnchor[]) => anchors
  .slice(0, 96)
  .map((anchor) => ({
    ...anchor,
    label: anchor.label.slice(0, 180),
    normalized: anchor.normalized.slice(0, 180),
    matchText: anchor.matchText.slice(0, 120),
  }));

export async function buildEnrichmentJobInputs(
  input: BuildEnrichmentJobInput,
): Promise<EnrichmentJobInput[]> {
  const promptVersion = input.promptVersion ?? ENRICHMENT_PROMPT_VERSION;
  const ontologyVersion = input.ontologyVersion ?? ENRICHMENT_ONTOLOGY_VERSION;
  const chunks = createEvidenceBlockChunks(input.blocks, {
    size: input.chunkSize,
    overlap: input.chunkOverlap,
  });
  const effectiveChunks = chunks.length ? chunks : [input.blocks.slice(0, 1)];
  return Promise.all(effectiveChunks.map(async (chunkBlocks, index) => {
    const startOrdinal = chunkBlocks.at(0)?.ordinal ?? 0;
    const endOrdinal = chunkBlocks.at(-1)?.ordinal ?? startOrdinal;
    const chunkKey = `chunk:${index + 1}:${effectiveChunks.length}:${startOrdinal}-${endOrdinal}`;
    const idempotencyKey = await createEnrichmentIdempotencyKey({
      documentHash: input.document.hash,
      parserVersion: input.document.parserVersion,
      promptVersion,
      providerVersion: input.providerVersion,
      ontologyVersion,
      chunkKey,
      reprocessNonce: input.reprocessNonce,
    });
    const chunkBlockIds = new Set(chunkBlocks.map((block) => block.id));
    const discoveredAnchors = resolveSemanticAnchors({ nodes: input.nodes, blocks: chunkBlocks });
    const anchorNodeIds = new Set(discoveredAnchors.flatMap((anchor) => anchor.nodeId ? [anchor.nodeId] : []));
    const nodes = selectNodesForChunk(input.nodes, input.nodeBlockIds, chunkBlockIds, anchorNodeIds);
    const anchors = serializeSemanticAnchors(resolveSemanticAnchors({ nodes, blocks: chunkBlocks }));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const existingRelations = input.existingRelations
      .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .slice(0, ENRICHMENT_INPUT_LIMITS.maxExistingRelations);
    const overlap = Math.max(0, Math.min(
      Math.floor(input.chunkOverlap ?? ENRICHMENT_INPUT_LIMITS.evidenceBlockOverlap),
      Math.max(0, chunkBlocks.length - 1),
    ));
    return {
      jobId: input.jobId
        ? `${input.jobId}:chunk-${index + 1}`
        : `enrichment:${idempotencyKey.slice(0, 40)}`,
      idempotencyKey,
      document: input.document,
      provider: ENRICHMENT_PROVIDER,
      providerVersion: input.providerVersion,
      promptVersion,
      ontologyVersion,
      chunk: {
        index,
        count: effectiveChunks.length,
        key: chunkKey,
        startOrdinal,
        endOrdinal,
        overlapBefore: index === 0 ? 0 : overlap,
        overlapAfter: index === effectiveChunks.length - 1 ? 0 : overlap,
      },
      nodes,
      anchors,
      existingRelations,
      evidenceBlocks: serializeEvidenceBlocks(chunkBlocks),
      constraints: {
        allowedRelationTypes: relationTypes,
        maxCandidateRelations: ENRICHMENT_INPUT_LIMITS.maxCandidateRelations,
        evidenceRequired: true as const,
      },
    };
  }));
}

export async function buildEnrichmentJobInput(
  input: BuildEnrichmentJobInput,
): Promise<EnrichmentJobInput> {
  const jobs = await buildEnrichmentJobInputs(input);
  return jobs[0];
}
