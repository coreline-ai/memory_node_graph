import type { KnowledgeEdge, KnowledgeNode, RelationKind } from "../../graph-data";
import type { DocumentBlock } from "../markdown/extract-graph";

export const ENRICHMENT_PROVIDER = "codex" as const;
export const ENRICHMENT_PROMPT_VERSION = "atlas-relations-v1";

export const ENRICHMENT_INPUT_LIMITS = Object.freeze({
  maxNodes: 220,
  maxExistingRelations: 540,
  maxEvidenceBlocks: 120,
  maxEvidenceBlockCharacters: 1_200,
  maxEvidenceCharacters: 48_000,
  maxCandidateRelations: 96,
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
  "connector_auth_required",
  "connector_unavailable",
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
  nodes: KnowledgeNode[];
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

export const CONNECTOR_HEARTBEAT_STATUSES = ["online", "offline"] as const;
export type ConnectorHeartbeatStatus = (typeof CONNECTOR_HEARTBEAT_STATUSES)[number];

export type ConnectorHeartbeatRecord = {
  connectorId: string;
  status: ConnectorHeartbeatStatus;
  version: string;
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
  reprocessNonce?: string;
}) {
  const canonicalParts = [
    input.documentHash,
    input.parserVersion,
    input.promptVersion,
    input.providerVersion,
  ];
  if (input.reprocessNonce) canonicalParts.push(input.reprocessNonce);
  const canonical = JSON.stringify(canonicalParts);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

const relationTypes: RelationKind[] = [
  "supports",
  "extends",
  "requires",
  "uses",
  "mitigates",
  "risks",
  "contradicts",
];

export type CodexEnrichmentOutput = {
  relations: EnrichmentRelationCandidate[];
  warnings: string[];
};

export const ENRICHMENT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["relations", "warnings"],
  properties: {
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

export async function buildEnrichmentJobInput(input: {
  jobId?: string;
  reprocessNonce?: string;
  document: EnrichmentJobInput["document"];
  providerVersion: string;
  promptVersion?: string;
  nodes: KnowledgeNode[];
  existingRelations: KnowledgeEdge[];
  blocks: DocumentBlock[];
}): Promise<EnrichmentJobInput> {
  const promptVersion = input.promptVersion ?? ENRICHMENT_PROMPT_VERSION;
  const idempotencyKey = await createEnrichmentIdempotencyKey({
    documentHash: input.document.hash,
    parserVersion: input.document.parserVersion,
    promptVersion,
    providerVersion: input.providerVersion,
    reprocessNonce: input.reprocessNonce,
  });

  return {
    jobId: input.jobId ?? `enrichment:${idempotencyKey.slice(0, 40)}`,
    idempotencyKey,
    document: input.document,
    provider: ENRICHMENT_PROVIDER,
    providerVersion: input.providerVersion,
    promptVersion,
    nodes: input.nodes.slice(0, ENRICHMENT_INPUT_LIMITS.maxNodes),
    existingRelations: input.existingRelations.slice(
      0,
      ENRICHMENT_INPUT_LIMITS.maxExistingRelations,
    ),
    evidenceBlocks: serializeEvidenceBlocks(input.blocks),
    constraints: {
      allowedRelationTypes: relationTypes,
      maxCandidateRelations: ENRICHMENT_INPUT_LIMITS.maxCandidateRelations,
      evidenceRequired: true,
    },
  };
}
