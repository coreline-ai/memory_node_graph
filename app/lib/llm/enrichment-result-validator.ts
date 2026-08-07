import {
  ENRICHMENT_INPUT_LIMITS,
  type CodexEnrichmentOutput,
  type EnrichmentEntityMentionCandidate,
  type EnrichmentJobRecord,
  type EnrichmentRelationCandidate,
  type EnrichmentResult,
} from "./enrichment-contracts.js";

export class EnrichmentValidationError extends Error {
  readonly code = "invalid_result" as const;

  constructor(message: string) {
    super(message);
    this.name = "EnrichmentValidationError";
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const limitedText = (value: unknown, max: number) =>
  typeof value === "string" ? value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, max) : "";

function parseRelation(
  value: unknown,
  job: EnrichmentJobRecord,
  index: number,
): { relation?: EnrichmentRelationCandidate; warning?: string } {
  const row = object(value);
  if (!row) return { warning: `관계 ${index + 1}: 객체가 아닙니다.` };

  const source = limitedText(row.source, 240);
  const target = limitedText(row.target, 240);
  const type = limitedText(row.type, 40);
  const note = limitedText(row.note, 500);
  const confidence = Number(row.confidence);
  const nodeIds = new Set(job.input.nodes.map((node) => node.id));
  const allowedTypes = new Set<string>(job.input.constraints.allowedRelationTypes);
  if (!nodeIds.has(source) || !nodeIds.has(target)) {
    return { warning: `관계 ${index + 1}: 허용되지 않은 노드 ID입니다.` };
  }
  if (source === target) return { warning: `관계 ${index + 1}: 자기 자신을 연결할 수 없습니다.` };
  if (!allowedTypes.has(type)) return { warning: `관계 ${index + 1}: 허용되지 않은 관계 유형입니다.` };
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { warning: `관계 ${index + 1}: 신뢰도 범위가 잘못되었습니다.` };
  }
  if (!note) return { warning: `관계 ${index + 1}: 관계 설명이 없습니다.` };
  if (!Array.isArray(row.evidence) || row.evidence.length < 1 || row.evidence.length > 4) {
    return { warning: `관계 ${index + 1}: 근거는 1~4개여야 합니다.` };
  }

  const blockIds = new Set(job.input.evidenceBlocks.map((block) => block.id));
  const evidence = row.evidence.flatMap((value) => {
    const item = object(value);
    if (!item) return [];
    const blockId = limitedText(item.blockId, 240);
    const explanation = limitedText(item.explanation, 500);
    return blockIds.has(blockId) && explanation ? [{ blockId, explanation }] : [];
  });
  if (evidence.length !== row.evidence.length) {
    return { warning: `관계 ${index + 1}: 존재하지 않거나 설명이 없는 근거 블록입니다.` };
  }

  return {
    relation: {
      source,
      target,
      type: type as EnrichmentRelationCandidate["type"],
      confidence,
      note,
      evidence,
    },
  };
}

export function parseCodexEnrichmentOutput(value: unknown): CodexEnrichmentOutput {
  const row = object(value);
  if (!row || !Array.isArray(row.relations) || !Array.isArray(row.warnings)) {
    throw new EnrichmentValidationError("Codex 출력은 relations와 warnings 배열을 포함해야 합니다.");
  }
  if (row.relations.length > ENRICHMENT_INPUT_LIMITS.maxCandidateRelations) {
    throw new EnrichmentValidationError("Codex 관계 후보 수가 상한을 초과했습니다.");
  }
  return {
    entityMentions: Array.isArray(row.entityMentions)
      ? row.entityMentions as EnrichmentEntityMentionCandidate[]
      : [],
    relations: row.relations as EnrichmentRelationCandidate[],
    warnings: row.warnings.flatMap((warning) => {
      const text = limitedText(warning, 500);
      return text ? [text] : [];
    }).slice(0, 20),
  };
}

export function validateEnrichmentResult(
  value: unknown,
  job: EnrichmentJobRecord,
): EnrichmentResult {
  const row = object(value);
  if (!row) throw new EnrichmentValidationError("보강 결과가 JSON 객체가 아닙니다.");
  if (
    row.jobId !== job.id ||
    row.idempotencyKey !== job.idempotencyKey ||
    row.documentHash !== job.documentHash ||
    row.provider !== job.provider ||
    row.providerVersion !== job.providerVersion ||
    row.promptVersion !== job.promptVersion
  ) {
    throw new EnrichmentValidationError("보강 결과의 작업·문서·Provider 버전이 일치하지 않습니다.");
  }
  if (row.status !== "completed" && row.status !== "warning") {
    throw new EnrichmentValidationError("보강 결과 상태가 올바르지 않습니다.");
  }
  if (!Array.isArray(row.relations) || row.relations.length > job.input.constraints.maxCandidateRelations) {
    throw new EnrichmentValidationError("보강 관계 배열이 없거나 상한을 초과했습니다.");
  }

  const warnings = Array.isArray(row.warnings)
    ? row.warnings.flatMap((warning) => {
      const text = limitedText(warning, 500);
      return text ? [text] : [];
    }).slice(0, 20)
    : [];
  const existing = new Set(job.input.existingRelations.map(
    (edge) => `${edge.source}|${edge.target}|${edge.type}`,
  ));
  const nodeIds = new Set(job.input.nodes.map((node) => node.id));
  const blockIds = new Set(job.input.evidenceBlocks.map((block) => block.id));
  const entityMentions = new Map<string, EnrichmentEntityMentionCandidate>();
  if (Array.isArray(row.entityMentions)) {
    row.entityMentions.forEach((candidate, index) => {
      const item = object(candidate);
      const nodeId = limitedText(item?.nodeId, 240);
      const confidence = Number(item?.confidence);
      const evidenceRows = Array.isArray(item?.evidence) ? item.evidence : [];
      const evidence = evidenceRows.flatMap((value) => {
        const evidenceItem = object(value);
        const blockId = limitedText(evidenceItem?.blockId, 240);
        const explanation = limitedText(evidenceItem?.explanation, 500);
        return blockIds.has(blockId) && explanation ? [{ blockId, explanation }] : [];
      });
      if (
        !nodeIds.has(nodeId)
        || !Number.isFinite(confidence)
        || confidence < 0
        || confidence > 1
        || evidence.length === 0
        || evidence.length !== evidenceRows.length
      ) {
        warnings.push(`엔티티 mention ${index + 1}: 허용되지 않은 노드·신뢰도·근거라 제외했습니다.`);
        return;
      }
      const current = entityMentions.get(nodeId);
      if (!current || confidence > current.confidence) {
        entityMentions.set(nodeId, { nodeId, confidence, evidence });
      }
    });
  }
  const accepted = new Map<string, EnrichmentRelationCandidate>();
  row.relations.forEach((candidate, index) => {
    const parsed = parseRelation(candidate, job, index);
    if (parsed.warning) {
      warnings.push(parsed.warning);
      return;
    }
    const relation = parsed.relation!;
    const key = `${relation.source}|${relation.target}|${relation.type}`;
    if (existing.has(key) || accepted.has(key)) {
      warnings.push(`관계 ${index + 1}: 기존 또는 중복 관계라 제외했습니다.`);
      return;
    }
    accepted.set(key, relation);
  });

  const usageRow = object(row.usage);
  const usage = usageRow
    ? {
      inputTokens: Math.max(0, Number(usageRow.inputTokens) || 0),
      cachedInputTokens: Math.max(0, Number(usageRow.cachedInputTokens) || 0),
      cacheWriteInputTokens: Math.max(0, Number(usageRow.cacheWriteInputTokens) || 0),
      outputTokens: Math.max(0, Number(usageRow.outputTokens) || 0),
      reasoningOutputTokens: Math.max(0, Number(usageRow.reasoningOutputTokens) || 0),
    }
    : undefined;
  const finalWarnings = warnings.slice(0, 20);
  return {
    jobId: job.id,
    idempotencyKey: job.idempotencyKey,
    documentHash: job.documentHash,
    provider: job.provider,
    providerVersion: job.providerVersion,
    promptVersion: job.promptVersion,
    status: finalWarnings.length ? "warning" : row.status,
    entityMentions: [...entityMentions.values()]
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    relations: [...accepted.values()],
    warnings: finalWarnings,
    usage,
  };
}
