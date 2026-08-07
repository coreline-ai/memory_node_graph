import {
  GRAPH_ANSWER_LIMITS,
  GRAPH_ANSWER_UNCERTAINTIES,
  type CodexGraphAnswerOutput,
  type GraphAnswerClaim,
  type GraphAnswerJobRecord,
  type GraphAnswerResult,
} from "./graph-answer-contracts.js";

export class GraphAnswerValidationError extends Error {
  readonly code = "invalid_result" as const;

  constructor(message: string) {
    super(message);
    this.name = "GraphAnswerValidationError";
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const normalizedText = (value: unknown, maximum: number) => {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : "";
};

export function parseCodexGraphAnswerOutput(value: unknown): CodexGraphAnswerOutput {
  const row = object(value);
  if (!row || !Array.isArray(row.claims) || !Array.isArray(row.limitations)) {
    throw new GraphAnswerValidationError("Codex 답변은 answer, claims, uncertainty, limitations를 포함해야 합니다.");
  }
  const answer = normalizedText(row.answer, GRAPH_ANSWER_LIMITS.maxAnswerCharacters);
  if (!answer) throw new GraphAnswerValidationError("Codex 답변이 비어 있거나 길이 상한을 초과했습니다.");
  if (row.claims.length < 1 || row.claims.length > GRAPH_ANSWER_LIMITS.maxClaims) {
    throw new GraphAnswerValidationError("Codex 근거 주장 수가 상한을 벗어났습니다.");
  }
  const claims = row.claims.map((value, index) => {
    const claim = object(value);
    const text = normalizedText(claim?.text, GRAPH_ANSWER_LIMITS.maxClaimCharacters);
    const citationIds = Array.isArray(claim?.citationIds)
      ? claim.citationIds.map((id) => normalizedText(id, 240)).filter(Boolean)
      : [];
    if (
      !text
      || citationIds.length < 1
      || citationIds.length > GRAPH_ANSWER_LIMITS.maxCitationsPerClaim
      || new Set(citationIds).size !== citationIds.length
    ) {
      throw new GraphAnswerValidationError(`Codex 주장 ${index + 1}의 텍스트 또는 인용 형식이 잘못되었습니다.`);
    }
    return { text, citationIds };
  });
  if (!GRAPH_ANSWER_UNCERTAINTIES.includes(row.uncertainty as never)) {
    throw new GraphAnswerValidationError("Codex 답변의 불확실성 값이 올바르지 않습니다.");
  }
  if (row.limitations.length > GRAPH_ANSWER_LIMITS.maxLimitations) {
    throw new GraphAnswerValidationError("Codex 답변의 한계 설명 수가 상한을 초과했습니다.");
  }
  const limitations = row.limitations.map((value, index) => {
    const text = normalizedText(value, GRAPH_ANSWER_LIMITS.maxLimitationCharacters);
    if (!text) throw new GraphAnswerValidationError(`Codex 한계 설명 ${index + 1}이 비어 있거나 너무 깁니다.`);
    return text;
  });
  return {
    answer,
    claims,
    uncertainty: row.uncertainty as CodexGraphAnswerOutput["uncertainty"],
    limitations,
  };
}

const expectedAnswer = (claims: GraphAnswerClaim[]) => claims.map((claim) => claim.text).join(" ");

export function validateGraphAnswerResult(
  value: unknown,
  job: GraphAnswerJobRecord,
): GraphAnswerResult {
  const row = object(value);
  if (!row) throw new GraphAnswerValidationError("그래프 답변 결과가 JSON 객체가 아닙니다.");
  if (
    row.jobId !== job.id
    || row.idempotencyKey !== job.idempotencyKey
    || row.provider !== job.input.provider
    || row.providerVersion !== job.input.providerVersion
    || row.promptVersion !== job.input.promptVersion
    || row.status !== "completed"
  ) {
    throw new GraphAnswerValidationError("그래프 답변 결과의 작업·Provider 버전이 일치하지 않습니다.");
  }

  const output = parseCodexGraphAnswerOutput(row);
  const allowedCitationIds = new Set(job.input.constraints.allowedCitationIds);
  const actualContextCitationIds = new Set(job.input.retrieval.citations.map((citation) => citation.id));
  for (const [index, claim] of output.claims.entries()) {
    for (const citationId of claim.citationIds) {
      if (!allowedCitationIds.has(citationId) || !actualContextCitationIds.has(citationId)) {
        throw new GraphAnswerValidationError(`주장 ${index + 1}이 검색 context에 없는 인용을 사용했습니다.`);
      }
    }
  }
  if (output.answer !== expectedAnswer(output.claims)) {
    throw new GraphAnswerValidationError("답변은 근거가 연결된 claims의 텍스트만 순서대로 포함해야 합니다.");
  }
  const citationIds = [...new Set(output.claims.flatMap((claim) => claim.citationIds))];
  if (!citationIds.length) {
    throw new GraphAnswerValidationError("인용 없는 답변은 저장할 수 없습니다.");
  }

  const usageRow = object(row.usage);
  const usage = usageRow ? {
    inputTokens: Math.max(0, Number(usageRow.inputTokens) || 0),
    cachedInputTokens: Math.max(0, Number(usageRow.cachedInputTokens) || 0),
    cacheWriteInputTokens: Math.max(0, Number(usageRow.cacheWriteInputTokens) || 0),
    outputTokens: Math.max(0, Number(usageRow.outputTokens) || 0),
    reasoningOutputTokens: Math.max(0, Number(usageRow.reasoningOutputTokens) || 0),
  } : undefined;

  return {
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    provider: job.input.provider,
    providerVersion: job.input.providerVersion,
    promptVersion: job.input.promptVersion,
    status: "completed",
    answer: output.answer,
    claims: output.claims,
    citationIds,
    uncertainty: output.uncertainty,
    limitations: output.limitations,
    usage,
  };
}
