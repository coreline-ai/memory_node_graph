import type { Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";
import type {
  Domain,
  KnowledgeEdge,
  KnowledgeNode,
  RelationEvidence,
  NodeKind,
  RelationKind,
} from "../../graph-data";
import { stableKey } from "./normalize";

export type DocumentBlock = {
  id: string;
  type: string;
  depth: number;
  text: string;
  ordinal: number;
  sourceUrl?: string;
};

export type NodeEvidence = {
  blockId: string;
  sourceUrl?: string;
};

export type ExtractedGraph = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
  blocks: DocumentBlock[];
  nodeBlockIds: Record<string, string>;
  nodeEvidence?: Record<string, NodeEvidence>;
};

const textOf = (node: unknown): string => {
  if (!node || typeof node !== "object") return "";
  const value = node as { value?: unknown; alt?: unknown; children?: unknown[] };
  if (typeof value.value === "string") return value.value;
  if (typeof value.alt === "string") return value.alt;
  return Array.isArray(value.children) ? value.children.map(textOf).join("") : "";
};

const short = (value: string, size = 54) =>
  value.length > size ? `${value.slice(0, size - 1).trim()}…` : value;

const includesAny = (value: string, candidates: string[]) =>
  candidates.some((candidate) => value.includes(candidate));

const classifyDomain = (value: string): Domain => {
  const text = value.toLowerCase();
  if (includesAny(text, ["memory", "rag", "retriev", "graph", "기억", "검색", "지식"])) return "memory";
  if (includesAny(text, ["agent", "tool", "workflow", "에이전트", "도구", "오케스트레이션"])) return "agents";
  if (includesAny(text, ["risk", "safe", "guard", "auth", "보안", "위험", "안전", "인증"])) return "safety";
  if (includesAny(text, ["product", "user", "ux", "제품", "사용자", "고객"])) return "product";
  if (includesAny(text, ["api", "server", "database", "storage", "infra", "서버", "데이터베이스", "배포"])) return "infrastructure";
  return "reasoning";
};

const classifyKind = (value: string): NodeKind => {
  const text = value.toLowerCase();
  if (includesAny(text, ["위험:", "risk:", "failure", "실패", "취약"])) return "risk";
  if (includesAny(text, ["도구:", "tool:", "library", "sdk", "라이브러리"])) return "tool";
  if (includesAny(text, ["모듈:", "system:", "architecture", "시스템", "파이프라인"])) return "system";
  if (includesAny(text, ["결정:", "기능:", "practice:", "방법", "절차", "정책"])) return "practice";
  if (value.length > 42 || /합니다$|한다$|이다$/.test(value)) return "thesis";
  return "concept";
};

const relationFor = (value: string): RelationKind => {
  const text = value.toLowerCase();
  if (includesAny(text, ["위험", "risk", "threat"])) return "risks";
  if (includesAny(text, ["완화", "mitigat", "방지"])) return "mitigates";
  if (includesAny(text, ["의존", "필요", "require", "depend"])) return "requires";
  if (includesAny(text, ["사용", "use", "호출"])) return "uses";
  if (includesAny(text, ["반대", "충돌", "contradict"])) return "contradicts";
  return "extends";
};

const makeNode = (
  id: string,
  label: string,
  summary: string,
  tags: string[],
): KnowledgeNode => ({
  id,
  label,
  shortLabel: short(label),
  kind: classifyKind(`${label} ${summary}`),
  domain: classifyDomain(`${label} ${summary}`),
  summary: short(summary || `${label}에 관한 문서 기반 지식입니다.`, 180),
  insight: "Markdown 구조와 명시적 문맥에서 규칙 기반으로 추출된 지식 노드입니다.",
  tags: [...new Set(tags)].slice(0, 8),
});

export function extractGraph(
  root: Root,
  documentId: string,
  fileName: string,
): ExtractedGraph {
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const rootBlockId = `block:${documentId}:root`;
  const blocks: DocumentBlock[] = [{
    id: rootBlockId,
    type: "document",
    depth: 0,
    text: fileName,
    ordinal: -1,
  }];
  const nodeById = new Map<string, KnowledgeNode>();
  const nodeBlockIds: Record<string, string> = {};
  const edgeKeys = new Set<string>();
  const headingStack: Array<{ depth: number; id: string }> = [];
  const documentNodeId = `document:${documentId}`;

  const addNode = (node: KnowledgeNode, blockId = rootBlockId) => {
    if (nodeById.has(node.id) || nodes.length >= 220) return nodeById.get(node.id);
    nodeById.set(node.id, node);
    nodeBlockIds[node.id] = blockId;
    nodes.push(node);
    return node;
  };
  const addEdge = (
    source: string,
    target: string,
    type: RelationKind,
    note: string,
    confidence = 0.82,
    evidence: RelationEvidence[] = [{
      blockId: rootBlockId,
      explanation: "문서 수준의 규칙 기반 관계입니다.",
    }],
  ) => {
    if (source === target || edges.length >= 540) return;
    const key = `${source}|${target}|${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, type, confidence, note: short(note, 140), evidence });
  };
  const evidenceFor = (blockId: string, explanation: string): RelationEvidence[] => [
    { blockId, explanation },
  ];
  const sourceBlockFor = (...candidates: string[]) =>
    blocks.find((block) =>
      block.id !== rootBlockId && candidates.some((candidate) => candidate && block.text.includes(candidate)),
    ) ?? blocks[0];

  addNode({
    id: documentNodeId,
    label: fileName,
    shortLabel: short(fileName),
    kind: "system",
    domain: "memory",
    summary: `${fileName}에서 생성된 문서 지식 루트입니다.`,
    insight: "문서의 제목 계층, 링크, 인라인 코드와 명시적 패턴을 연결합니다.",
    tags: ["document", fileName.split(".").pop() ?? "md"],
  }, rootBlockId);

  root.children.forEach((child: RootContent, ordinal) => {
    const text = textOf(child).replace(/\s+/g, " ").trim();
    if (!text) return;
    const depth = child.type === "heading" ? child.depth : 0;
    const blockId = `block:${documentId}:${ordinal}`;
    blocks.push({ id: blockId, type: child.type, depth, text: short(text, 1200), ordinal });

    if (child.type === "heading") {
      const nodeId = `section:${documentId}:${stableKey(`${depth}:${text}`)}`;
      const section = addNode(
        makeNode(nodeId, text, `문서의 ${depth}단계 제목 섹션입니다.`, ["section", `h${depth}`]),
        blockId,
      );
      if (!section) return;
      while (headingStack.length && headingStack.at(-1)!.depth >= depth) headingStack.pop();
      const parentId = headingStack.at(-1)?.id ?? documentNodeId;
      addEdge(
        parentId,
        nodeId,
        "extends",
        "문서 제목 계층에 포함됨",
        0.98,
        evidenceFor(blockId, "제목 계층에서 확인된 포함 관계입니다."),
      );
      headingStack.push({ depth, id: nodeId });
      return;
    }

    const parentId = headingStack.at(-1)?.id ?? documentNodeId;
    const explicit = text.match(/^(기능|모듈|의존성|결정|위험|도구|개념)\s*:\s*(.+)$/i);
    if (explicit) {
      const label = explicit[2].trim();
      const nodeId = `entity:${stableKey(`${explicit[1]}:${label}`)}`;
      const entity = addNode(makeNode(nodeId, label, text, [explicit[1], "explicit"]), blockId);
      if (entity) {
        addEdge(
          parentId,
          nodeId,
          relationFor(explicit[1]),
          text,
          0.94,
          evidenceFor(blockId, "명시적 Markdown 패턴에서 추출한 관계입니다."),
        );
      }
    }
  });

  visit(root, "inlineCode", (node) => {
    const label = textOf(node).trim();
    if (!label || label.length > 80) return;
    const block = sourceBlockFor(label);
    const nodeId = `entity:${stableKey(`code:${label.toLowerCase()}`)}`;
    const entity = addNode(
      makeNode(nodeId, label, `문서에서 인라인 코드로 강조된 개념입니다.`, ["code", "concept"]),
      block.id,
    );
    if (entity) {
      addEdge(
        documentNodeId,
        nodeId,
        "uses",
        `${fileName}에서 인라인 코드로 언급`,
        0.86,
        evidenceFor(block.id, "인라인 코드 언급에서 추출한 사용 관계입니다."),
      );
    }
  });

  visit(root, "link", (node) => {
    const label = textOf(node).trim() || node.url;
    if (!label || !node.url) return;
    const block = sourceBlockFor(label, node.url);
    const nodeId = `reference:${stableKey(node.url)}`;
    const reference = addNode(
      makeNode(nodeId, label, node.url, ["reference", "link"]),
      block.id,
    );
    if (reference) {
      addEdge(
        documentNodeId,
        nodeId,
        "uses",
        `Markdown 링크: ${node.url}`,
        0.9,
        evidenceFor(block.id, "Markdown 링크에서 추출한 참조 관계입니다."),
      );
    }
  });

  return { nodes, edges, blocks, nodeBlockIds };
}
