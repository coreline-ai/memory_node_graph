import type { KnowledgeNode, RelationKind } from "../../graph-data";
import type {
  EnrichmentEvidenceBlock,
  EnrichmentJobRecord,
} from "./enrichment-contracts";
import {
  anchorsForBlock,
  resolveSemanticAnchors,
  type SemanticAnchor,
  type SemanticAnchorKind,
} from "./semantic-anchor-resolver.js";

/**
 * Codex is a semantic enrichment pass. Document hierarchy, aliases and
 * mentions already come from the deterministic Markdown parser and must not
 * be re-created by the model.
 */
export const CODEX_SEMANTIC_RELATION_TYPES = [
  "implements",
  "depends_on",
  "calls",
  "reads_from",
  "writes_to",
  "produces",
  "tests",
  "references",
  "precedes",
  "blocks",
  "supersedes",
  "related_to",
  "supports",
  "extends",
  "requires",
  "uses",
  "mitigates",
  "risks",
  "contradicts",
] as const satisfies readonly RelationKind[];

export const MAX_RELATIONSHIP_CANDIDATE_SELECTION = 10;

export type RelationshipCandidateTier = "high" | "review" | "excluded";

export type RelationshipCandidateReason = {
  code: string;
  message: string;
};

export type RelationshipCandidateAnchor = {
  nodeId?: string;
  label: string;
  kind: SemanticAnchorKind;
  scope: SemanticAnchor["scope"];
  resolved: boolean;
  source: SemanticAnchor["source"];
};

export type RelationshipCandidate = {
  jobId: string;
  documentId: string;
  documentName: string;
  providerVersion: string;
  score: number;
  tier: RelationshipCandidateTier;
  expectedRelationType?: RelationKind;
  evidence: {
    blockId: string;
    ordinal: number;
    type: string;
    excerpt: string;
  };
  sourceNodeId?: string;
  targetNodeId?: string;
  /** All evidence-local anchors, including unresolved identifiers. */
  anchors: RelationshipCandidateAnchor[];
  anchorCount: number;
  resolvedAnchorCount: number;
  sourceAnchor?: RelationshipCandidateAnchor;
  targetAnchor?: RelationshipCandidateAnchor;
  matchedNodeIds: string[];
  positiveReasons: RelationshipCandidateReason[];
  exclusionReasons: RelationshipCandidateReason[];
};

/**
 * Read-only aggregate for the candidate-review screen and offline audits.
 * It accepts already-scored candidates only, so it cannot claim a job,
 * invoke Codex, or mutate D1.
 */
export type RelationshipCandidateAnchorAudit = {
  candidatesWithAnchorPair: number;
  totalAnchors: number;
  resolvedAnchors: number;
  unresolvedAnchors: number;
};

export function summarizeRelationshipCandidateAnchors(
  candidates: readonly RelationshipCandidate[],
): RelationshipCandidateAnchorAudit {
  return candidates.reduce<RelationshipCandidateAnchorAudit>((summary, candidate) => ({
    candidatesWithAnchorPair: summary.candidatesWithAnchorPair
      + (candidate.sourceAnchor && candidate.targetAnchor ? 1 : 0),
    totalAnchors: summary.totalAnchors + candidate.anchorCount,
    resolvedAnchors: summary.resolvedAnchors + candidate.resolvedAnchorCount,
    unresolvedAnchors: summary.unresolvedAnchors
      + Math.max(0, candidate.anchorCount - candidate.resolvedAnchorCount),
  }), {
    candidatesWithAnchorPair: 0,
    totalAnchors: 0,
    resolvedAnchors: 0,
    unresolvedAnchors: 0,
  });
}

type RelationSignal = {
  type: RelationKind;
  score: number;
  expressions: readonly RegExp[];
};

type AnchorPair = {
  source: SemanticAnchor;
  target: SemanticAnchor;
};

const highPriorityTypes = new Set<RelationKind>([
  "uses",
  "calls",
  "depends_on",
  "requires",
  "reads_from",
  "writes_to",
  "produces",
  "tests",
  "supports",
  "mitigates",
  "blocks",
]);

const structuralRelationTypes = new Set<RelationKind>([
  "documents",
  "plans",
  "contains",
  "mentions",
  "same_as",
]);

const relationSignals: readonly RelationSignal[] = [
  { type: "depends_on", score: 34, expressions: [/\bdepends?_?on\b/i, /의존(?:성|한다|하는)?/, /에 의존/] },
  { type: "requires", score: 33, expressions: [/\brequires?\b/i, /필수(?:이다|로)?/, /요구(?:된다|한다|사항)?/] },
  { type: "calls", score: 33, expressions: [/\bcalls?\b/i, /호출(?:한다|됩니다|됨)?/, /요청(?:한다|합니다|됨)?/] },
  { type: "writes_to", score: 32, expressions: [/\bwrites?_?to\b/i, /\bpersist(?:s|ed)?\b/i, /(?:저장(?!소)|기록|갱신|제출)(?:한다|됩니다|됨|하고|한|할|될)?/] },
  { type: "reads_from", score: 31, expressions: [/\breads?_?from\b/i, /\bfetch(?:es|ed)?\b/i, /(?:조회|읽기|불러오기)(?:한다|됩니다|됨)?/] },
  { type: "produces", score: 30, expressions: [/\bproduces?\b/i, /(?:생성|반환|출력|발행)(?:한다|됩니다|됨)?/] },
  { type: "tests", score: 30, expressions: [/\btests?\b/i, /\baudit\b/i, /(?:테스트|검증)(?:한다|합니다|됨)?/] },
  { type: "uses", score: 29, expressions: [/\buses?\b/i, /\busing\b/i, /(?:사용|통합|연동)(?:한다|합니다|됨)?/] },
  { type: "implements", score: 28, expressions: [/\bimplements?\b/i, /구현(?:한다|합니다|됨)?/] },
  { type: "supports", score: 27, expressions: [/\bsupports?\b/i, /지원(?:한다|합니다|됨)?/] },
  { type: "mitigates", score: 27, expressions: [/\bmitigates?\b/i, /(?:완화|대응)(?:한다|합니다|됨)?/] },
  { type: "blocks", score: 27, expressions: [/\bblocks?\b/i, /차단(?:한다|됩니다|됨)?/] },
  { type: "references", score: 18, expressions: [/\breferences?\b/i, /참조(?:한다|됩니다|됨)?/] },
  { type: "extends", score: 18, expressions: [/\bextends?\b/i, /확장(?:한다|합니다|됨)?/] },
  { type: "supersedes", score: 18, expressions: [/\bsupersedes?\b/i, /대체(?:한다|됩니다|됨)?/] },
  { type: "risks", score: 16, expressions: [/\brisks?\b/i, /위험(?:하다|이 있다|요소)?/] },
  { type: "contradicts", score: 16, expressions: [/\bcontradicts?\b/i, /충돌(?:한다|합니다|됨)?/] },
  { type: "related_to", score: 12, expressions: [/\brelated[_\s-]?to\b/i, /관련(?:된다|이 있다)?/] },
];

const compact = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim();
const comparable = (value: string) => compact(value).toLocaleLowerCase("en-US");
const reason = (code: string, message: string): RelationshipCandidateReason => ({ code, message });

const changelog = /(?:^|\b)(?:changelog|release notes?|변경 이력|버전 기록)(?:\b|$)/i;
const linkItem = /^\s*[-*+]\s+(?:\[[^\]]+\]\([^)]*\)|https?:\/\/\S+)/gm;
const checklistOnly = /^\s*[-*+]\s+\[[ xX]\]\s+[^\n]+\s*$/;
const commandOnly = /^\s*(?:npm|pnpm|yarn|npx|bun|brew|curl|git)\s+[\w-]+/i;
const commandMention = /\b(?:npm|pnpm|yarn|npx|bun)\s+run\b/i;
const badgeOnly = /(?:shields\.io|badge|<img\b)/i;
const flowArrow = /(?:--?>|→|=>|⟶|↔)/;
const phaseIdentifier = /\b(?:phase\s*\d+|p\d+(?:-i)?|dev-\d+)\b/i;
const apiRoute = /\/api\/[a-z0-9_./:[\]-]+/gi;
const migrationArtifact = /(?:\bdrizzle\/\d+_|\b(?:migration|schema)\s+(?:sql|file)|(?:마이그레이션|스키마)\s*(?:sql|파일|목록))/i;

const hasMultipleLinks = (text: string) => (text.match(linkItem) ?? []).length >= 2;

const publicAnchor = (anchor: SemanticAnchor): RelationshipCandidateAnchor => ({
  ...(anchor.nodeId ? { nodeId: anchor.nodeId } : {}),
  label: anchor.label,
  kind: anchor.kind,
  scope: anchor.scope,
  resolved: Boolean(anchor.nodeId),
  source: anchor.source,
});

const uniqueAnchors = (anchors: readonly SemanticAnchor[]) => {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    const key = `${anchor.nodeId ?? "unresolved"}|${anchor.kind}|${anchor.normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const explicitPrecedes = (text: string, anchors: readonly SemanticAnchor[]) =>
  flowArrow.test(text)
  && phaseIdentifier.test(text)
  && uniqueAnchors(anchors.filter((anchor) => anchor.nodeId && ["phase", "task", "workflow"].includes(anchor.kind))).length >= 2;

const detectSignals = (text: string, anchors: readonly SemanticAnchor[]) => {
  const matches = relationSignals
    .filter((signal) => signal.expressions.some((expression) => expression.test(text)))
    .sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
  if (explicitPrecedes(text, anchors)) matches.push({ type: "precedes", score: 36, expressions: [] });
  return matches.sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
};

const kinds = (...values: SemanticAnchorKind[]) => new Set<SemanticAnchorKind>(values);
const directionContracts: Partial<Record<RelationKind, { source: Set<SemanticAnchorKind>; target: Set<SemanticAnchorKind> }>> = {
  implements: { source: kinds("component", "workflow"), target: kinds("feature", "api", "workflow") },
  depends_on: { source: kinds("component", "feature", "workflow"), target: kinds("component", "technology", "storage", "api", "data") },
  calls: { source: kinds("component", "feature", "workflow", "api"), target: kinds("api", "component", "workflow") },
  reads_from: { source: kinds("component", "feature", "workflow", "api"), target: kinds("storage", "data") },
  writes_to: { source: kinds("component", "workflow", "api"), target: kinds("storage") },
  produces: { source: kinds("component", "workflow", "api"), target: kinds("data") },
  tests: { source: kinds("test"), target: kinds("component", "feature", "api", "workflow") },
  references: { source: kinds("file", "task"), target: kinds("file", "api", "technology") },
  precedes: { source: kinds("phase", "task", "workflow"), target: kinds("phase", "task", "workflow") },
  blocks: { source: kinds("risk", "task"), target: kinds("feature", "workflow", "phase", "task") },
  supports: { source: kinds("component", "feature", "decision", "test"), target: kinds("component", "feature", "workflow") },
  requires: { source: kinds("component", "feature", "workflow", "decision"), target: kinds("component", "workflow", "technology", "storage", "data", "decision") },
  uses: { source: kinds("component", "feature", "workflow"), target: kinds("technology", "api", "storage") },
  mitigates: { source: kinds("decision", "test", "component"), target: kinds("risk") },
};

const indexInText = (text: string, anchor: SemanticAnchor) => {
  const haystack = comparable(text);
  const needles = [anchor.matchText, anchor.label]
    .map(comparable)
    .filter((value, index, values) => value.length >= 3 && values.indexOf(value) === index);
  const indexes = needles.map((needle) => haystack.indexOf(needle)).filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : Number.MAX_SAFE_INTEGER;
};

/**
 * Direction is accepted only if source and target have an ontology-compatible
 * type and occur in that order in the same evidence block. This intentionally
 * favors false negatives over reversing a relationship.
 */
const selectAnchorPair = (type: RelationKind | undefined, anchors: readonly SemanticAnchor[], text: string): AnchorPair | undefined => {
  if (!type) return undefined;
  const contract = directionContracts[type];
  if (!contract) return undefined;
  const resolved = uniqueAnchors(anchors.filter((anchor) => anchor.nodeId));
  const pairs: Array<AnchorPair & { sourcePosition: number; targetPosition: number }> = [];
  for (const source of resolved) {
    if (!contract.source.has(source.kind)) continue;
    for (const target of resolved) {
      if (source.nodeId === target.nodeId || !contract.target.has(target.kind)) continue;
      const sourcePosition = indexInText(text, source);
      const targetPosition = indexInText(text, target);
      if (sourcePosition === Number.MAX_SAFE_INTEGER || targetPosition === Number.MAX_SAFE_INTEGER) continue;
      if (sourcePosition > targetPosition) continue;
      pairs.push({ source, target, sourcePosition, targetPosition });
    }
  }
  return pairs.sort((left, right) =>
    left.sourcePosition - right.sourcePosition
    || left.targetPosition - right.targetPosition
    || left.source.nodeId!.localeCompare(right.source.nodeId!)
    || left.target.nodeId!.localeCompare(right.target.nodeId!))[0];
};

const existingRelation = (
  job: EnrichmentJobRecord,
  sourceNodeId: string | undefined,
  targetNodeId: string | undefined,
  type: RelationKind | undefined,
) => {
  if (!sourceNodeId || !targetNodeId || !type) return false;
  return job.input.existingRelations.some((edge) => edge.type === type && (
    (edge.source === sourceNodeId && edge.target === targetNodeId)
    || (edge.source === targetNodeId && edge.target === sourceNodeId)
  ));
};

const excludedBlockReasons = (block: EnrichmentEvidenceBlock): RelationshipCandidateReason[] => {
  const text = compact(block.text);
  const reasons: RelationshipCandidateReason[] = [];
  if (!text) reasons.push(reason("empty", "내용이 없는 근거 블록입니다."));
  if (changelog.test(text)) reasons.push(reason("changelog", "변경 이력·릴리스 노트는 관계 보강 대상에서 제외합니다."));
  if (hasMultipleLinks(text)) reasons.push(reason("link_list", "링크 나열 블록은 관계 보강 대상에서 제외합니다."));
  if (checklistOnly.test(text)) reasons.push(reason("checklist", "단독 체크리스트 항목은 양쪽 대상을 증명하지 못합니다."));
  if (badgeOnly.test(text)) reasons.push(reason("badge", "배지·이미지 전용 블록은 관계 근거가 아닙니다."));
  if ((commandOnly.test(text) || commandMention.test(text)) && !flowArrow.test(text)) {
    reasons.push(reason("command", "설치·실행 명령만 있는 블록은 관계 보강 대상에서 제외합니다."));
  }
  if ((text.match(apiRoute) ?? []).length >= 2 && !flowArrow.test(text)) {
    reasons.push(reason("api_route_list", "API 경로 나열은 호출·읽기·쓰기 관계의 양쪽 대상을 증명하지 못합니다."));
  }
  if (migrationArtifact.test(text) && !flowArrow.test(text)) {
    reasons.push(reason("migration_artifact", "마이그레이션·스키마 파일 나열은 실행 관계의 양쪽 대상을 증명하지 못합니다."));
  }
  if (block.type === "code" && !flowArrow.test(text)) {
    reasons.push(reason("code_only", "관계 흐름이 없는 코드 블록은 관계 보강 대상에서 제외합니다."));
  }
  return reasons;
};

const allInputAnchors = (job: EnrichmentJobRecord) => job.input.anchors?.length
  ? job.input.anchors
  : resolveSemanticAnchors({ nodes: job.input.nodes, blocks: job.input.evidenceBlocks });

const candidateForBlock = (
  job: EnrichmentJobRecord,
  block: EnrichmentEvidenceBlock,
  inputAnchors: readonly SemanticAnchor[],
): RelationshipCandidate => {
  const exclusionReasons = excludedBlockReasons(block);
  const text = compact(block.text);
  const blockAnchors = uniqueAnchors(anchorsForBlock(inputAnchors, block.id));
  const resolvedAnchors = blockAnchors.filter((anchor) => anchor.nodeId);
  const signals = detectSignals(text, blockAnchors);
  const expectedRelationType = signals[0]?.type;
  const pair = selectAnchorPair(expectedRelationType, resolvedAnchors, text);
  const sourceNodeId = pair?.source.nodeId;
  const targetNodeId = pair?.target.nodeId;
  const positiveReasons: RelationshipCandidateReason[] = [];

  if (expectedRelationType) {
    positiveReasons.push(reason("relation_signal", `명시 관계 표현으로 ${expectedRelationType} 후보를 찾았습니다.`));
  } else {
    exclusionReasons.push(reason("no_relation_signal", "명시적인 의미 관계 동사를 찾지 못했습니다."));
  }
  if (resolvedAnchors.length >= 2) {
    positiveReasons.push(reason("two_anchors", `근거 블록에서 해석된 의미 앵커 ${resolvedAnchors.length}개를 찾았습니다.`));
  } else {
    exclusionReasons.push(reason("insufficient_anchors", "관계를 검증할 해석된 양쪽 의미 앵커가 부족합니다."));
  }
  if (pair) {
    positiveReasons.push(reason(
      "anchor_pair",
      `${pair.source.label} → ${expectedRelationType} → ${pair.target.label} 방향을 ontology 계약으로 확인했습니다.`,
    ));
  } else if (expectedRelationType && resolvedAnchors.length >= 2) {
    exclusionReasons.push(reason("direction_unresolved", "양쪽 앵커가 있어도 ontology 타입·문장 순서로 관계 방향을 확정할 수 없습니다."));
  }
  if (blockAnchors.some((anchor) => !anchor.nodeId)) {
    exclusionReasons.push(reason("unresolved_anchor", "명시 식별자 일부가 현재 chunk의 그래프 노드로 해석되지 않아 수동 검토가 필요합니다."));
  }
  if (expectedRelationType && structuralRelationTypes.has(expectedRelationType)) {
    exclusionReasons.push(reason("structural_type", "구조 관계는 규칙 기반 파서가 담당하므로 Codex 후보에서 제외합니다."));
  }
  if (expectedRelationType === "precedes" && !explicitPrecedes(text, resolvedAnchors)) {
    exclusionReasons.push(reason("document_order", "실제 Phase·Task·workflow 근거가 없는 문서 순서는 제외합니다."));
  }
  const duplicate = existingRelation(job, sourceNodeId, targetNodeId, expectedRelationType);
  if (duplicate) exclusionReasons.push(reason("existing_relation", "동일한 규칙 관계가 이미 작업 입력에 존재합니다."));

  let score = expectedRelationType ? signals[0].score : 0;
  score += Math.min(24, resolvedAnchors.length * 12);
  // A fully resolved, direction-compatible pair is the decisive quality
  // signal. This keeps the high threshold unchanged while letting concise,
  // explicit sentences qualify without padding their prose length.
  if (pair) score += 5;
  if (expectedRelationType === "precedes" && explicitPrecedes(text, resolvedAnchors)) score += 5;
  if (text.length >= 80 && text.length <= 1_200) score += 4;
  if (expectedRelationType && highPriorityTypes.has(expectedRelationType)) score += 8;
  if (duplicate) score -= 32;
  if (exclusionReasons.length) score = Math.min(score, 45);
  score = Math.max(0, Math.min(100, score));

  const hardExcluded = exclusionReasons.some((entry) => [
    "empty",
    "changelog",
    "link_list",
    "checklist",
    "badge",
    "command",
    "code_only",
    "api_route_list",
    "migration_artifact",
    "no_relation_signal",
    "structural_type",
    "document_order",
  ].includes(entry.code));
  const tier: RelationshipCandidateTier = hardExcluded
    ? "excluded"
    : expectedRelationType && pair && !duplicate && score >= 70
      ? "high"
      : "review";
  if (tier === "review" && !exclusionReasons.length) {
    exclusionReasons.push(reason("score_below_high", "명시 관계 근거는 있으나 자동 선택 기준에 못 미쳐 수동 검토가 필요합니다."));
  }

  const anchors = blockAnchors.map(publicAnchor);
  return {
    jobId: job.id,
    documentId: job.documentId,
    documentName: job.input.document.name,
    providerVersion: job.providerVersion,
    score,
    tier,
    expectedRelationType,
    evidence: {
      blockId: block.id,
      ordinal: block.ordinal,
      type: block.type,
      excerpt: text.slice(0, 280),
    },
    ...(sourceNodeId ? { sourceNodeId } : {}),
    ...(targetNodeId ? { targetNodeId } : {}),
    anchors,
    anchorCount: anchors.length,
    resolvedAnchorCount: resolvedAnchors.length,
    ...(pair ? { sourceAnchor: publicAnchor(pair.source), targetAnchor: publicAnchor(pair.target) } : {}),
    matchedNodeIds: [...new Set(resolvedAnchors.flatMap((anchor) => anchor.nodeId ? [anchor.nodeId] : []))].sort(),
    positiveReasons,
    exclusionReasons,
  };
};

const tierRank: Record<RelationshipCandidateTier, number> = { high: 0, review: 1, excluded: 2 };

const compareCandidates = (left: RelationshipCandidate, right: RelationshipCandidate) =>
  tierRank[left.tier] - tierRank[right.tier]
  || right.score - left.score
  || left.documentName.localeCompare(right.documentName)
  || left.evidence.ordinal - right.evidence.ordinal
  || left.jobId.localeCompare(right.jobId);

/** Scores one queued job without writing D1 or calling an LLM. */
export function scoreRelationshipCandidate(job: EnrichmentJobRecord): RelationshipCandidate {
  const blocks = [...job.input.evidenceBlocks]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const inputAnchors = allInputAnchors(job);
  const candidates = blocks.map((block) => candidateForBlock(job, block, inputAnchors));
  if (candidates.length) return candidates.sort(compareCandidates)[0];
  return {
    jobId: job.id,
    documentId: job.documentId,
    documentName: job.input.document.name,
    providerVersion: job.providerVersion,
    score: 0,
    tier: "excluded",
    evidence: { blockId: "", ordinal: 0, type: "unknown", excerpt: "" },
    anchors: [],
    anchorCount: 0,
    resolvedAnchorCount: 0,
    matchedNodeIds: [],
    positiveReasons: [],
    exclusionReasons: [reason("empty_job", "분석할 근거 블록이 없는 작업입니다.")],
  };
}

export function rankRelationshipCandidates(jobs: readonly EnrichmentJobRecord[]) {
  return jobs.map(scoreRelationshipCandidate).sort(compareCandidates);
}

export class RelationshipCandidateSelectionError extends Error {}

/**
 * Produces a bounded, ranked selection for a later runtime command. This is
 * deliberately data-only: it never claims a job or starts Codex.
 */
export function selectHighRelationshipCandidates(
  candidates: readonly RelationshipCandidate[],
  requestedJobIds: readonly string[],
) {
  const normalizedRequestedIds = requestedJobIds.map((value) => value.trim()).filter(Boolean);
  if (!normalizedRequestedIds.length || normalizedRequestedIds.length > MAX_RELATIONSHIP_CANDIDATE_SELECTION) {
    throw new RelationshipCandidateSelectionError(
      `관계 보강 선택은 1~${MAX_RELATIONSHIP_CANDIDATE_SELECTION}개여야 합니다.`,
    );
  }
  const jobIds = [...new Set(normalizedRequestedIds)];
  if (jobIds.length !== normalizedRequestedIds.length) {
    throw new RelationshipCandidateSelectionError("같은 관계 후보를 중복해서 선택할 수 없습니다.");
  }
  const byJobId = new Map(candidates.map((candidate) => [candidate.jobId, candidate]));
  const selected = jobIds.map((jobId) => byJobId.get(jobId));
  if (selected.some((candidate) => !candidate)) {
    throw new RelationshipCandidateSelectionError("현재 후보 목록에 없는 작업은 선택할 수 없습니다.");
  }
  if (selected.some((candidate) => candidate?.tier !== "high")) {
    throw new RelationshipCandidateSelectionError("high 등급의 의미 관계 후보만 선택할 수 있습니다.");
  }
  return (selected as RelationshipCandidate[]).sort(compareCandidates);
}

export function isCodexSemanticRelationType(type: RelationKind) {
  return CODEX_SEMANTIC_RELATION_TYPES.includes(type as typeof CODEX_SEMANTIC_RELATION_TYPES[number]);
}

/** `precedes` is meaningful only when both endpoints are actual ordered work items. */
export function isCodexOrderRelationAllowed(
  type: RelationKind,
  source: string,
  target: string,
  nodes: readonly KnowledgeNode[],
) {
  if (type !== "precedes") return true;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return [source, target].every((id) => {
    const node = byId.get(id);
    if (!node) return false;
    return /(?:phase|task|workflow)/i.test(node.tags.join(" "))
      || phaseIdentifier.test(`${node.label} ${node.shortLabel} ${node.summary}`);
  });
}
