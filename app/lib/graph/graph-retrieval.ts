import type { KnowledgeEdge, KnowledgeNode } from "../../graph-data";

export const GRAPH_QUERY_MAX_LENGTH = 500;
export const GRAPH_QUERY_MAX_TERMS = 6;
export const GRAPH_QUERY_NODE_LIMIT = 48;
export const GRAPH_QUERY_RELATION_LIMIT = 96;
export const GRAPH_QUERY_CITATION_LIMIT = 24;

export type GraphQueryLimits = {
  nodes: number;
  relations: number;
  citations: number;
};

export type NormalizedGraphQuestion = {
  original: string;
  normalized: string;
  terms: string[];
};

export type GraphRetrievalCitation = {
  id: string;
  documentId?: string;
  fileName?: string;
  repositoryOwner?: string;
  repositoryName?: string;
  relativePath?: string;
  text: string;
  sourceUrl?: string;
  nodeIds: string[];
};

export type GraphRetrievalSource = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  citations: GraphRetrievalCitation[];
};

export type GraphRetrievalResult = {
  query: NormalizedGraphQuestion;
  context: {
    nodes: Array<KnowledgeNode & {
      retrieval: {
        score: number;
        hop: 0 | 1 | 2;
        matchedTerms: string[];
        degree: number;
        centrality: number;
        evidenceCount: number;
      };
    }>;
    relations: Array<KnowledgeEdge & {
      retrieval: {
        score: number;
        evidenceComplete: boolean;
      };
    }>;
    citations: GraphRetrievalCitation[];
  };
  meta: {
    algorithm: "lexical-graph-neighborhood-ranker-v1";
    generatedAt: string;
    answerReady: boolean;
    nodeBudget: number;
    relationBudget: number;
    citationBudget: number;
    candidateNodeCount: number;
    candidateRelationCount: number;
    candidateCitationCount: number;
    message: string;
  };
};

export class GraphQueryValidationError extends Error {
  constructor(readonly code: "invalid_question" | "invalid_limits", message: string) {
    super(message);
    this.name = "GraphQueryValidationError";
  }
}

const STOP_WORDS = new Set([
  "그리고", "그러면", "관련", "대한", "대해", "무엇", "어떤", "있는", "하는", "에서", "으로",
  "구조", "시스템", "구현", "기능", "개발", "프로젝트", "문서",
  "the", "and", "for", "with", "what", "how", "this", "that", "from", "into", "about",
]);

const clampLimit = (value: unknown, fallback: number, maximum: number) => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new GraphQueryValidationError("invalid_limits", `검색 한도는 1~${maximum} 범위의 정수여야 합니다.`);
  }
  return parsed;
};

export function normalizeGraphQueryLimits(value: unknown): GraphQueryLimits {
  const object = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    nodes: clampLimit(object.nodes, 24, GRAPH_QUERY_NODE_LIMIT),
    relations: clampLimit(object.relations, 48, GRAPH_QUERY_RELATION_LIMIT),
    citations: clampLimit(object.citations, 12, GRAPH_QUERY_CITATION_LIMIT),
  };
}

export function normalizeGraphQuestion(value: unknown): NormalizedGraphQuestion {
  if (typeof value !== "string") {
    throw new GraphQueryValidationError("invalid_question", "질문은 문자열이어야 합니다.");
  }
  const original = value;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length < 2) {
    throw new GraphQueryValidationError("invalid_question", "질문은 두 글자 이상 입력하세요.");
  }
  if (normalized.length > GRAPH_QUERY_MAX_LENGTH) {
    throw new GraphQueryValidationError(
      "invalid_question",
      `질문은 ${GRAPH_QUERY_MAX_LENGTH}자 이하여야 합니다.`,
    );
  }
  const terms = [...normalized.toLocaleLowerCase("en-US").matchAll(/[\p{L}\p{N}][\p{L}\p{N}._+#-]*/gu)]
    .map((match) => match[0])
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term))
    .filter((term, index, all) => all.indexOf(term) === index)
    .slice(0, GRAPH_QUERY_MAX_TERMS);
  if (!terms.length) {
    throw new GraphQueryValidationError("invalid_question", "검색할 수 있는 핵심 단어가 없습니다.");
  }
  return { original, normalized, terms };
}

const searchableNodeText = (node: KnowledgeNode) => [
  node.label,
  node.shortLabel,
  node.summary,
  node.insight,
  ...node.tags,
].join(" ").normalize("NFKC").toLocaleLowerCase("en-US");

const textMatches = (text: string, terms: readonly string[]) =>
  terms.filter((term) => text.includes(term));

export const graphNodeLexicalMatch = (node: KnowledgeNode, query: NormalizedGraphQuestion) => {
  const text = searchableNodeText(node);
  const matchedTerms = textMatches(text, query.terms);
  if (!matchedTerms.length) return { score: 0, matchedTerms };
  const label = `${node.label} ${node.shortLabel}`.normalize("NFKC").toLocaleLowerCase("en-US");
  const labelMatches = textMatches(label, query.terms).length;
  const phrase = text.includes(query.normalized.toLocaleLowerCase("en-US")) ? 0.2 : 0;
  const coverage = matchedTerms.length / query.terms.length;
  return {
    score: Math.min(1, 0.18 + coverage * 0.42 + (labelMatches / query.terms.length) * 0.32 + phrase),
    matchedTerms,
  };
};

const citationMatchScore = (citation: GraphRetrievalCitation, query: NormalizedGraphQuestion) => {
  const text = citation.text.normalize("NFKC").toLocaleLowerCase("en-US");
  const matched = textMatches(text, query.terms).length;
  if (!matched) return 0;
  return Math.min(1, 0.15 + (matched / query.terms.length) * 0.6);
};

const edgeIdentity = (edge: KnowledgeEdge) => `${edge.source}|${edge.target}|${edge.type}`;

export function retrieveGraphContext(input: {
  query: NormalizedGraphQuestion;
  source: GraphRetrievalSource;
  limits: GraphQueryLimits;
  now?: string;
}): GraphRetrievalResult {
  const nodes = new Map(input.source.nodes.map((node) => [node.id, node]));
  const edges = input.source.edges.filter((edge) => nodes.has(edge.source) && nodes.has(edge.target));
  const adjacency = new Map<string, KnowledgeEdge[]>(input.source.nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge);
    adjacency.get(edge.target)?.push(edge);
  }

  const ranks = new Map<string, { relevance: number; hop: 0 | 1 | 2; matchedTerms: string[] }>();
  for (const node of input.source.nodes) {
    const match = graphNodeLexicalMatch(node, input.query);
    if (match.score > 0) ranks.set(node.id, { relevance: match.score, hop: 0, matchedTerms: match.matchedTerms });
  }
  const citationScores = new Map<string, number>();
  for (const citation of input.source.citations) {
    const score = citationMatchScore(citation, input.query);
    citationScores.set(citation.id, score);
    if (!score) continue;
    for (const nodeId of citation.nodeIds) {
      if (!nodes.has(nodeId)) continue;
      const existing = ranks.get(nodeId);
      if (!existing || existing.relevance < score * 0.65) {
        ranks.set(nodeId, { relevance: score * 0.65, hop: 0, matchedTerms: input.query.terms.filter((term) => citation.text.toLocaleLowerCase("en-US").includes(term)) });
      }
    }
  }

  const seedIds = [...ranks.entries()]
    .sort((left, right) => right[1].relevance - left[1].relevance || left[0].localeCompare(right[0]))
    .slice(0, 24)
    .map(([id]) => id);
  let frontier = seedIds;
  for (const hop of [1, 2] as const) {
    const next = new Set<string>();
    for (const nodeId of frontier) {
      const parent = ranks.get(nodeId);
      if (!parent) continue;
      for (const edge of adjacency.get(nodeId) ?? []) {
        const neighborId = edge.source === nodeId ? edge.target : edge.source;
        const relevance = parent.relevance * Math.max(0.1, edge.confidence) * (hop === 1 ? 0.64 : 0.42);
        const existing = ranks.get(neighborId);
        if (!existing || relevance > existing.relevance) {
          ranks.set(neighborId, { relevance, hop, matchedTerms: [] });
          next.add(neighborId);
        }
      }
    }
    frontier = [...next];
  }

  const maximumDegree = Math.max(1, ...input.source.nodes.map((node) => adjacency.get(node.id)?.length ?? 0));
  const citationCountByNode = new Map<string, number>();
  for (const citation of input.source.citations) {
    for (const nodeId of citation.nodeIds) {
      citationCountByNode.set(nodeId, (citationCountByNode.get(nodeId) ?? 0) + 1);
    }
  }
  const scoredNodes = [...ranks.entries()].map(([id, rank]) => {
    const node = nodes.get(id)!;
    const degree = adjacency.get(id)?.length ?? 0;
    const centrality = degree / maximumDegree;
    const evidenceCount = citationCountByNode.get(id) ?? 0;
    const bestConfidence = Math.max(0, ...(adjacency.get(id) ?? []).map((edge) => edge.confidence));
    const score = rank.relevance * 0.72
      + centrality * 0.1
      + bestConfidence * 0.12
      + Math.min(1, evidenceCount / 3) * 0.06;
    return {
      ...node,
      retrieval: {
        score: Number(score.toFixed(6)),
        hop: rank.hop,
        matchedTerms: rank.matchedTerms,
        degree,
        centrality: Number(centrality.toFixed(6)),
        evidenceCount,
      },
    };
  }).sort((left, right) =>
    right.retrieval.score - left.retrieval.score
    || left.retrieval.hop - right.retrieval.hop
    || left.id.localeCompare(right.id));
  const selectedNodes = scoredNodes.slice(0, input.limits.nodes);
  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));

  const selectedEdges = edges
    .filter((edge) => selectedNodeIds.has(edge.source) && selectedNodeIds.has(edge.target))
    .map((edge) => {
      const endpointScore = ((ranks.get(edge.source)?.relevance ?? 0) + (ranks.get(edge.target)?.relevance ?? 0)) / 2;
      const evidenceComplete = Boolean(edge.evidence?.length);
      return {
        ...edge,
        retrieval: {
          score: Number((endpointScore * 0.55 + edge.confidence * 0.35 + (evidenceComplete ? 0.1 : 0)).toFixed(6)),
          evidenceComplete,
        },
      };
    })
    .sort((left, right) => right.retrieval.score - left.retrieval.score || edgeIdentity(left).localeCompare(edgeIdentity(right)))
    .slice(0, input.limits.relations);

  const relationBlockIds = new Set(selectedEdges.flatMap((edge) => edge.evidence?.map((item) => item.blockId) ?? []));
  const selectedCitations = input.source.citations
    .filter((citation) =>
      citation.nodeIds.some((nodeId) => selectedNodeIds.has(nodeId)) || relationBlockIds.has(citation.id))
    .sort((left, right) =>
      (citationScores.get(right.id) ?? 0) - (citationScores.get(left.id) ?? 0)
      || Number(relationBlockIds.has(right.id)) - Number(relationBlockIds.has(left.id))
      || left.id.localeCompare(right.id))
    .slice(0, input.limits.citations);

  const answerReady = selectedNodes.length > 0 && selectedCitations.length > 0;
  return {
    query: input.query,
    context: { nodes: selectedNodes, relations: selectedEdges, citations: selectedCitations },
    meta: {
      algorithm: "lexical-graph-neighborhood-ranker-v1",
      generatedAt: input.now ?? new Date().toISOString(),
      answerReady,
      nodeBudget: input.limits.nodes,
      relationBudget: input.limits.relations,
      citationBudget: input.limits.citations,
      candidateNodeCount: input.source.nodes.length,
      candidateRelationCount: edges.length,
      candidateCitationCount: input.source.citations.length,
      message: selectedNodes.length
        ? answerReady
          ? "근거가 있는 그래프 검색 결과입니다. 아직 LLM 답변은 생성하지 않았습니다."
          : "관련 노드는 찾았지만 인용 가능한 문서 근거가 부족합니다."
        : "질문과 일치하는 그래프 근거를 찾지 못했습니다.",
    },
  };
}
