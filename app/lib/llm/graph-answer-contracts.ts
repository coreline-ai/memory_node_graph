import type { GraphRetrievalResult } from "../graph/graph-retrieval";

export const GRAPH_ANSWER_PROVIDER = "codex" as const;
export const GRAPH_ANSWER_PROVIDER_VERSION = "codex-sdk-0.146.0";
export const GRAPH_ANSWER_PROMPT_VERSION = "atlas-graph-answer-v1";

export const GRAPH_ANSWER_LIMITS = Object.freeze({
  maxAnswerCharacters: 4_000,
  maxClaims: 12,
  maxClaimCharacters: 800,
  maxCitationsPerClaim: 4,
  maxLimitations: 8,
  maxLimitationCharacters: 500,
});

export const GRAPH_ANSWER_JOB_STATUSES = [
  "queued",
  "leased",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type GraphAnswerJobStatus = (typeof GRAPH_ANSWER_JOB_STATUSES)[number];

export const GRAPH_ANSWER_UNCERTAINTIES = ["low", "medium", "high"] as const;
export type GraphAnswerUncertainty = (typeof GRAPH_ANSWER_UNCERTAINTIES)[number];

export const GRAPH_ANSWER_ERROR_CODES = [
  "runtime_auth_required",
  "runtime_unavailable",
  "lease_conflict",
  "lease_expired",
  "insufficient_evidence",
  "invalid_input",
  "invalid_result",
  "provider_error",
  "provider_timeout",
  "cancelled",
  "retry_exhausted",
  "unknown",
] as const;

export type GraphAnswerErrorCode = (typeof GRAPH_ANSWER_ERROR_CODES)[number];

export type GraphAnswerClaim = {
  text: string;
  citationIds: string[];
};

export type GraphAnswerJobInput = {
  jobId: string;
  idempotencyKey: string;
  provider: typeof GRAPH_ANSWER_PROVIDER;
  providerVersion: string;
  promptVersion: string;
  question: string;
  retrieval: {
    algorithm: GraphRetrievalResult["meta"]["algorithm"];
    contextFingerprint: string;
    nodes: GraphRetrievalResult["context"]["nodes"];
    relations: GraphRetrievalResult["context"]["relations"];
    citations: GraphRetrievalResult["context"]["citations"];
  };
  constraints: {
    allowedCitationIds: string[];
    evidenceRequired: true;
    maxClaims: number;
  };
};

export type GraphAnswerResult = {
  jobId: string;
  idempotencyKey: string;
  provider: typeof GRAPH_ANSWER_PROVIDER;
  providerVersion: string;
  promptVersion: string;
  status: "completed";
  answer: string;
  claims: GraphAnswerClaim[];
  citationIds: string[];
  uncertainty: GraphAnswerUncertainty;
  limitations: string[];
  usage?: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
};

export type GraphAnswerJobRecord = {
  id: string;
  idempotencyKey: string;
  status: GraphAnswerJobStatus;
  input: GraphAnswerJobInput;
  result?: GraphAnswerResult;
  attemptCount: number;
  maxAttempts: number;
  manualRetryCount: number;
  lastManualRetryAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: GraphAnswerErrorCode;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type CodexGraphAnswerOutput = {
  answer: string;
  claims: GraphAnswerClaim[];
  uncertainty: GraphAnswerUncertainty;
  limitations: string[];
};

export const GRAPH_ANSWER_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["answer", "claims", "uncertainty", "limitations"],
  properties: {
    answer: {
      type: "string",
      minLength: 1,
      maxLength: GRAPH_ANSWER_LIMITS.maxAnswerCharacters,
    },
    claims: {
      type: "array",
      minItems: 1,
      maxItems: GRAPH_ANSWER_LIMITS.maxClaims,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "citationIds"],
        properties: {
          text: {
            type: "string",
            minLength: 1,
            maxLength: GRAPH_ANSWER_LIMITS.maxClaimCharacters,
          },
          citationIds: {
            type: "array",
            minItems: 1,
            maxItems: GRAPH_ANSWER_LIMITS.maxCitationsPerClaim,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 240 },
          },
        },
      },
    },
    uncertainty: { type: "string", enum: GRAPH_ANSWER_UNCERTAINTIES },
    limitations: {
      type: "array",
      maxItems: GRAPH_ANSWER_LIMITS.maxLimitations,
      items: {
        type: "string",
        minLength: 1,
        maxLength: GRAPH_ANSWER_LIMITS.maxLimitationCharacters,
      },
    },
  },
});

const canonicalContext = (retrieval: GraphRetrievalResult) => ({
  algorithm: retrieval.meta.algorithm,
  query: retrieval.query.normalized,
  nodes: retrieval.context.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    domain: node.domain,
    summary: node.summary,
    insight: node.insight,
    tags: node.tags,
  })),
  relations: retrieval.context.relations.map((relation) => ({
    source: relation.source,
    target: relation.target,
    type: relation.type,
    confidence: relation.confidence,
    note: relation.note,
    evidence: relation.evidence,
  })),
  citations: retrieval.context.citations.map((citation) => ({
    id: citation.id,
    documentId: citation.documentId,
    text: citation.text,
    sourceUrl: citation.sourceUrl,
    nodeIds: citation.nodeIds,
  })),
});

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
};

export async function buildGraphAnswerJobInput(input: {
  retrieval: GraphRetrievalResult;
  providerVersion: string;
  promptVersion?: string;
}): Promise<GraphAnswerJobInput> {
  if (!input.retrieval.meta.answerReady || !input.retrieval.context.citations.length) {
    throw new Error("인용 가능한 검색 근거가 없어 답변 작업을 만들 수 없습니다.");
  }
  const promptVersion = input.promptVersion ?? GRAPH_ANSWER_PROMPT_VERSION;
  const canonical = canonicalContext(input.retrieval);
  const contextFingerprint = await sha256(JSON.stringify(canonical));
  const idempotencyKey = await sha256(JSON.stringify([
    input.retrieval.query.normalized,
    contextFingerprint,
    GRAPH_ANSWER_PROVIDER,
    input.providerVersion,
    promptVersion,
  ]));
  const allowedCitationIds = input.retrieval.context.citations.map((citation) => citation.id);
  return {
    jobId: `graph-answer:${idempotencyKey.slice(0, 40)}`,
    idempotencyKey,
    provider: GRAPH_ANSWER_PROVIDER,
    providerVersion: input.providerVersion,
    promptVersion,
    question: input.retrieval.query.normalized,
    retrieval: {
      algorithm: input.retrieval.meta.algorithm,
      contextFingerprint,
      nodes: structuredClone(input.retrieval.context.nodes),
      relations: structuredClone(input.retrieval.context.relations),
      citations: structuredClone(input.retrieval.context.citations),
    },
    constraints: {
      allowedCitationIds,
      evidenceRequired: true,
      maxClaims: GRAPH_ANSWER_LIMITS.maxClaims,
    },
  };
}
