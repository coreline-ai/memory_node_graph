import type { Root } from "mdast";
import { visit } from "unist-util-visit";
import type {
  Domain,
  KnowledgeEdge,
  KnowledgeNode,
  NodeKind,
  RelationEvidence,
  RelationKind,
} from "../../graph-data";
import type { DocumentSourceDescriptor, GitHubDocumentSourceDescriptor } from "../graph/model";
import {
  extractGraph,
  type DocumentBlock,
  type ExtractedGraph,
  type NodeEvidence,
} from "./extract-graph";
import {
  explicitEntitiesIn,
  explicitIdentifierRelationsIn,
  explicitIdentifiersIn,
  githubHeadingSlug,
  relationFromExplicitContext,
  resolveRepositoryMarkdownLink,
} from "./explicit-rules";
import { entityAliasesIn, resolveEntityAlias } from "../graph/entity-alias-resolver";
import { sha256, stableKey } from "./normalize";
import { MARKDOWN_PARSER_VERSION } from "./parse-markdown";

export type MarkdownParserProfile = "generic" | "github-readme" | "github-dev-plan";

export const MARKDOWN_PROFILE_VERSIONS: Record<MarkdownParserProfile, string> = {
  generic: MARKDOWN_PARSER_VERSION,
  "github-readme": "remark-ast-github-readme-4",
  "github-dev-plan": "remark-ast-github-dev-plan-4",
};

export type ProfiledExtractionContext = {
  documentId: string;
  fileName: string;
  sourceDescriptor: DocumentSourceDescriptor;
};

type AstNode = {
  type?: string;
  value?: unknown;
  alt?: unknown;
  url?: unknown;
  depth?: unknown;
  checked?: unknown;
  children?: AstNode[];
  position?: {
    start?: { line?: number };
    end?: { line?: number };
  };
};

type SectionRole =
  | "purpose"
  | "feature"
  | "technology"
  | "install"
  | "operation"
  | "phase"
  | "risk"
  | "decision"
  | "dependency"
  | "completion"
  | "section";

const textOf = (node: unknown): string => {
  if (!node || typeof node !== "object") return "";
  const value = node as AstNode;
  if (typeof value.value === "string") return value.value;
  if (typeof value.alt === "string") return value.alt;
  return Array.isArray(value.children) ? value.children.map(textOf).join("") : "";
};

const directListItemText = (node: AstNode) =>
  (node.children ?? [])
    .filter((child) => child.type !== "list")
    .map(textOf)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const short = (value: string, size = 180) =>
  value.length > size ? `${value.slice(0, size - 1).trim()}…` : value;

const includesAny = (value: string, candidates: readonly string[]) =>
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

const sectionRole = (heading: string, profile: MarkdownParserProfile): SectionRole => {
  const value = heading.trim().toLowerCase();
  if (profile === "github-dev-plan") {
    if (/^(phase|단계)\b/i.test(value)) return "phase";
    if (includesAny(value, ["위험", "리스크", "risk", "issue", "이슈"])) return "risk";
    if (includesAny(value, ["결정", "decision"])) return "decision";
    if (includesAny(value, ["의존", "dependency", "prerequisite", "선행"])) return "dependency";
    if (includesAny(value, ["완료 조건", "완료 기준", "definition of done", "acceptance"])) return "completion";
  }
  if (includesAny(value, ["소개", "개요", "목적", "overview", "about", "goal"])) return "purpose";
  if (includesAny(value, ["기능", "feature", "capabilit"])) return "feature";
  if (includesAny(value, ["기술", "tech", "stack", "framework", "language"])) return "technology";
  if (includesAny(value, ["설치", "install", "getting started", "setup"])) return "install";
  if (includesAny(value, ["운영", "실행", "사용법", "usage", "deploy", "run", "operation"])) return "operation";
  return "section";
};

const roleTags = (profile: MarkdownParserProfile, role: SectionRole) =>
  ["section", profile, role].filter((value, index, values) => values.indexOf(value) === index);

const normalizedReferenceUrl = (value: unknown) => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

export function selectMarkdownParserProfile(
  sourceDescriptor: DocumentSourceDescriptor,
): MarkdownParserProfile {
  if (sourceDescriptor.type === "manual") return "generic";
  if (sourceDescriptor.relativePath === "README.md") return "github-readme";
  if (/^dev-plan\/(?:[^/]+\/)*[^/]+\.md$/i.test(sourceDescriptor.relativePath)) {
    return "github-dev-plan";
  }
  throw new Error(`지원하지 않는 GitHub Markdown 경로입니다: ${sourceDescriptor.relativePath}`);
}

export function parserVersionForMarkdownSource(sourceDescriptor: DocumentSourceDescriptor) {
  return MARKDOWN_PROFILE_VERSIONS[selectMarkdownParserProfile(sourceDescriptor)];
}

const makeNode = (input: {
  id: string;
  label: string;
  summary: string;
  kind: NodeKind;
  tags: string[];
}): KnowledgeNode => ({
  id: input.id,
  label: input.label,
  shortLabel: short(input.label, 54),
  kind: input.kind,
  domain: classifyDomain(`${input.label} ${input.summary} ${input.tags.join(" ")}`),
  summary: short(input.summary),
  insight: "GitHub Markdown 구조와 원문 line evidence에서 규칙 기반으로 추출했습니다.",
  tags: [...new Set(input.tags)].slice(0, 10),
});

async function extractGitHubProfile(
  root: Root,
  context: ProfiledExtractionContext & { sourceDescriptor: GitHubDocumentSourceDescriptor },
  profile: Exclude<MarkdownParserProfile, "generic">,
): Promise<ExtractedGraph> {
  const { documentId, sourceDescriptor } = context;
  const nodes: KnowledgeNode[] = [];
  const edges: KnowledgeEdge[] = [];
  const blocks: DocumentBlock[] = [];
  const nodeBlockIds: Record<string, string> = {};
  const nodeEvidence: Record<string, NodeEvidence> = {};
  const nodeById = new Map<string, KnowledgeNode>();
  const edgeKeys = new Set<string>();
  const localIdOccurrences = new Map<string, number>();
  const parentByNode = new WeakMap<object, AstNode>();
  const structureNodeByAst = new WeakMap<object, string>();
  const blockByAst = new WeakMap<object, DocumentBlock>();
  const blockRoles = new Map<string, SectionRole>();
  const blockOwnerIds = new Map<string, string>();
  const headingNodeBySlug = new Map<string, string>();
  const headingSlugOccurrences = new Map<string, number>();
  const sourceUrl = sourceDescriptor.sourceUrl.replace(/#.*$/, "");
  const repositoryNodeId = `repository:github:${sourceDescriptor.repositoryId}`;
  const documentNodeId = `document:${documentId}`;
  const planNodeId = profile === "github-dev-plan"
    ? `plan:github:${sourceDescriptor.repositoryId}:${stableKey(sourceDescriptor.relativePath)}`
    : undefined;
  const sourceLocalId = (prefix: string, semanticKey: string) => {
    const occurrence = localIdOccurrences.get(`${prefix}:${semanticKey}`) ?? 0;
    localIdOccurrences.set(`${prefix}:${semanticKey}`, occurrence + 1);
    return `${prefix}:${documentId}:${stableKey(`${sourceDescriptor.relativePath}:${semanticKey}:${occurrence}`)}`;
  };
  const rootBlock: DocumentBlock = {
    id: `block:${documentId}:root`,
    type: "document",
    depth: 0,
    text: sourceDescriptor.relativePath,
    ordinal: -1,
    sourceUrl: `${sourceUrl}#L1`,
  };
  blocks.push(rootBlock);
  blockOwnerIds.set(rootBlock.id, documentNodeId);

  visit(root, (node: unknown, _index, parent: unknown) => {
    if (node && typeof node === "object" && parent && typeof parent === "object") {
      parentByNode.set(node as object, parent as AstNode);
    }
  });

  const lineUrlFor = (node: AstNode) => {
    const start = node.position?.start?.line;
    const end = node.position?.end?.line;
    if (!start || start < 1) return sourceUrl;
    return `${sourceUrl}#L${start}${end && end > start ? `-L${end}` : ""}`;
  };
  const evidenceFor = (block: DocumentBlock, explanation: string): RelationEvidence[] => [{
    blockId: block.id,
    explanation,
    sourceUrl: block.sourceUrl ?? sourceUrl,
  }];
  const containingBlockFor = (rawNode: AstNode) => {
    let current: AstNode | undefined = rawNode;
    while (current) {
      const block = blockByAst.get(current as object);
      if (block) return block;
      current = parentByNode.get(current as object);
    }
    return rootBlock;
  };
  const addNode = (node: KnowledgeNode, block = rootBlock) => {
    const existing = nodeById.get(node.id);
    if (existing) {
      existing.tags = [...new Set([...existing.tags, ...node.tags])].slice(0, 10);
      return existing;
    }
    nodes.push(node);
    nodeById.set(node.id, node);
    nodeBlockIds[node.id] = block.id;
    nodeEvidence[node.id] = { blockId: block.id, sourceUrl: block.sourceUrl ?? sourceUrl };
    return node;
  };
  const addEdge = (
    source: string,
    target: string,
    type: RelationKind,
    note: string,
    block = rootBlock,
    confidence = 0.98,
    explanation = "GitHub Markdown 원문 구조에서 확인된 관계입니다.",
  ) => {
    if (
      source === target
      || !nodeById.has(source)
      || !nodeById.has(target)
    ) return;
    const key = `${source}|${target}|${type}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({
      source,
      target,
      type,
      confidence,
      note: short(note, 140),
      evidence: evidenceFor(block, explanation),
      layer: ["documents", "plans", "contains"].includes(type) ? "structural" : "explicit",
      origin: "rule",
      provider: "markdown-ast",
    });
  };

  addNode(makeNode({
    id: repositoryNodeId,
    label: sourceDescriptor.repositoryName,
    summary: `${sourceDescriptor.repositoryOwner}/${sourceDescriptor.repositoryName} GitHub 저장소입니다.`,
    kind: "system",
    tags: ["repository", "github", sourceDescriptor.repositoryOwner],
  }));
  addNode(makeNode({
    id: documentNodeId,
    label: sourceDescriptor.relativePath,
    summary: `${sourceDescriptor.repositoryName} 저장소의 ${sourceDescriptor.relativePath} 문서입니다.`,
    kind: "system",
    tags: ["document", profile, sourceDescriptor.relativePath],
  }));
  addEdge(repositoryNodeId, documentNodeId, "documents", "저장소의 GitHub Markdown 문서", rootBlock);
  if (planNodeId) {
    addNode(makeNode({
      id: planNodeId,
      label: sourceDescriptor.relativePath.split("/").at(-1)!,
      summary: `${sourceDescriptor.repositoryName} 저장소의 개발 계획입니다.`,
      kind: "system",
      tags: ["plan", "github-dev-plan"],
    }));
    addEdge(repositoryNodeId, planNodeId, "plans", "저장소 개발 계획", rootBlock);
    addEdge(planNodeId, documentNodeId, "documents", "개발 계획 원문 문서", rootBlock);
  }

  let currentRole: SectionRole = profile === "github-readme" ? "purpose" : "section";
  let currentSectionId = documentNodeId;
  const headingStack: Array<{ depth: number; id: string }> = [];
  let ordinal = 0;

  visit(root, (rawNode: unknown, _index, rawParent: unknown) => {
    const node = rawNode as AstNode;
    const parent = rawParent as AstNode | undefined;
    if (!node.type || node.type === "root" || node.type === "html") return;
    const shouldBlock = node.type === "heading"
      || node.type === "listItem"
      || (node.type === "paragraph" && parent?.type !== "listItem")
      || node.type === "code"
      || node.type === "blockquote"
      || node.type === "table";
    if (!shouldBlock) return;
    const rawText = node.type === "listItem" ? directListItemText(node) : textOf(node);
    const text = node.type === "code"
      ? rawText.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim()
      : rawText.replace(/\s+/g, " ").trim();
    if (!text) return;
    const block: DocumentBlock = {
      id: `block:${documentId}:${ordinal}`,
      type: node.type,
      depth: node.type === "heading" ? Number(node.depth ?? 0) : 0,
      text: short(text, 1_200),
      ordinal,
      sourceUrl: lineUrlFor(node),
    };
    ordinal += 1;
    blocks.push(block);
    blockByAst.set(rawNode as object, block);
    blockOwnerIds.set(block.id, currentSectionId);

    if (node.type === "heading") {
      const depth = Number(node.depth ?? 1);
      currentRole = sectionRole(text, profile);
      blockRoles.set(block.id, currentRole);
      if (profile === "github-dev-plan" && depth === 1) {
        currentSectionId = planNodeId!;
        const plan = nodeById.get(planNodeId!);
        if (plan) {
          plan.label = text;
          plan.shortLabel = short(text, 54);
          nodeBlockIds[plan.id] = block.id;
          nodeEvidence[plan.id] = { blockId: block.id, sourceUrl: block.sourceUrl ?? sourceUrl };
        }
        headingStack.length = 0;
        headingStack.push({ depth, id: currentSectionId });
        return;
      }
      while (headingStack.length && headingStack.at(-1)!.depth >= depth) headingStack.pop();
      const parentId = headingStack.at(-1)?.id
        ?? planNodeId
        ?? documentNodeId;
      const prefix = currentRole === "phase" ? "phase" : "section";
      const nodeId = sourceLocalId(prefix, `${depth}:${text}`);
      const section = addNode(makeNode({
        id: nodeId,
        label: text,
        summary: currentRole === "phase" ? `${text} 개발 단계입니다.` : `${text} 문서 섹션입니다.`,
        kind: currentRole === "phase" ? "system" : currentRole === "risk" ? "risk" : "concept",
        tags: roleTags(profile, currentRole),
      }), block);
      if (section) {
        addEdge(parentId, section.id, "contains", "Markdown 제목 계층", block);
        headingStack.push({ depth, id: section.id });
        currentSectionId = section.id;
        blockOwnerIds.set(block.id, section.id);
        const baseSlug = githubHeadingSlug(text);
        if (baseSlug) {
          const occurrence = headingSlugOccurrences.get(baseSlug) ?? 0;
          headingSlugOccurrences.set(baseSlug, occurrence + 1);
          headingNodeBySlug.set(occurrence ? `${baseSlug}-${occurrence}` : baseSlug, section.id);
        }
      }
      return;
    }

    blockRoles.set(block.id, currentRole);
    if (node.type === "paragraph") {
      const section = nodeById.get(currentSectionId);
      if (section && section.summary.endsWith("문서 섹션입니다.")) section.summary = short(text);
      return;
    }
    if (node.type !== "listItem") return;

    const checked = typeof node.checked === "boolean" ? node.checked : undefined;
    const isReadmeElement = profile === "github-readme"
      && ["feature", "install", "operation"].includes(currentRole);
    const isPlanElement = profile === "github-dev-plan"
      && (checked !== undefined || ["risk", "decision", "dependency", "completion"].includes(currentRole));
    if (!isReadmeElement && !isPlanElement) return;
    const status = checked === undefined ? undefined : checked ? "completed" : "pending";
    const itemKind: NodeKind = currentRole === "risk" ? "risk" : "practice";
    const itemId = sourceLocalId(checked === undefined ? "item" : "task", text);
    const item = addNode(makeNode({
      id: itemId,
      label: text,
      summary: status ? `${status === "completed" ? "완료" : "미완료"} 개발 작업입니다.` : `${currentRole} 항목입니다.`,
      kind: itemKind,
      tags: [checked === undefined ? currentRole : "task", profile, ...(status ? [status] : [])],
    }), block);
    if (!item) return;
    structureNodeByAst.set(rawNode as object, item.id);
    blockOwnerIds.set(block.id, item.id);
    let ancestor = parentByNode.get(rawNode as object);
    let structuralParentId: string | undefined;
    while (ancestor) {
      if (ancestor.type === "listItem") {
        structuralParentId = structureNodeByAst.get(ancestor as object);
        if (structuralParentId) break;
      }
      ancestor = parentByNode.get(ancestor as object);
    }
    const relation: RelationKind = currentRole === "risk" ? "risks"
      : currentRole === "dependency" ? "requires"
        : "contains";
    addEdge(
      structuralParentId ?? currentSectionId,
      item.id,
      structuralParentId ? "contains" : relation,
      structuralParentId ? "중첩 작업 구조" : `${currentRole} 구조 항목`,
      block,
      checked === undefined ? 0.94 : 0.99,
    );
  });

  const technologyBlocks = blocks.filter((block) =>
    block.id !== rootBlock.id && blockRoles.get(block.id) === "technology",
  );
  const inlineTechnologyBlocks: Array<{ block: DocumentBlock; text: string }> = [];
  visit(root, "inlineCode", (rawNode: unknown) => {
    const node = rawNode as AstNode;
    const text = textOf(node).trim();
    const block = containingBlockFor(node);
    if (text && block.id !== rootBlock.id) inlineTechnologyBlocks.push({ block, text });
  });
  const technologyEvidence = [
    ...technologyBlocks.map((block) => ({ block, text: block.text })),
    ...inlineTechnologyBlocks,
  ];
  const technologySeen = new Set<string>();
  for (const { block, text } of technologyEvidence) {
    for (const technology of entityAliasesIn(text)) {
      const technologyId = technology.canonicalId;
      const evidenceKey = `${technologyId}:${block.id}`;
      if (technologySeen.has(evidenceKey)) continue;
      technologySeen.add(evidenceKey);
      addNode(makeNode({
        id: technologyId,
        label: technology.label,
        summary: `${technology.label} 기술 엔티티입니다.`,
        kind: "tool",
        tags: ["technology", "shared"],
      }), block);
      addEdge(
        repositoryNodeId,
        technologyId,
        relationFromExplicitContext(text, "uses"),
        "README 또는 개발 계획에 명시된 기술",
        block,
        0.96,
      );
    }
  }

  const identifierNodeByKey = new Map<string, string>();
  const ensureIdentifierNode = (identifier: ReturnType<typeof explicitIdentifiersIn>[number], block: DocumentBlock) => {
    const existing = identifierNodeByKey.get(identifier.key);
    if (existing) return existing;
    const type = identifier.kind;
    const id = `${type}:github:${sourceDescriptor.repositoryId}:${stableKey(identifier.key)}`;
    const node = addNode(makeNode({
      id,
      label: identifier.label,
      summary: `${sourceDescriptor.repositoryName} 저장소의 명시적 ${type === "phase" ? "단계" : "작업"} 식별자입니다.`,
      kind: type === "phase" ? "system" : "practice",
      tags: [type, "identifier", `identifier:${identifier.key}`, "explicit", profile],
    }), block);
    if (!node) return undefined;
    identifierNodeByKey.set(identifier.key, node.id);
    return node.id;
  };

  for (const block of blocks) {
    if (block.id === rootBlock.id) continue;
    const ownerId = blockOwnerIds.get(block.id) ?? documentNodeId;
    const identifiers = explicitIdentifiersIn(block.text);
    for (const identifier of identifiers) {
      const targetId = ensureIdentifierNode(identifier, block);
      if (!targetId || targetId === ownerId) continue;
      addEdge(
        ownerId,
        targetId,
        nodeById.get(ownerId)?.tags.includes(identifier.kind) ? "same_as" : "references",
        `${identifier.kind} 식별자 참조: ${identifier.label}`,
        block,
        0.98,
        "동일 Markdown block에 명시된 단계·작업 식별자에서 직접 확인했습니다.",
      );
    }
    for (const relation of explicitIdentifierRelationsIn(block.text)) {
      const sourceIdentifier = identifiers.find((item) => item.key === relation.sourceKey);
      const targetIdentifier = identifiers.find((item) => item.key === relation.targetKey);
      if (!sourceIdentifier || !targetIdentifier) continue;
      const sourceId = ensureIdentifierNode(sourceIdentifier, block);
      const targetId = ensureIdentifierNode(targetIdentifier, block);
      if (!sourceId || !targetId) continue;
      addEdge(
        sourceId,
        targetId,
        relation.relation,
        `${sourceIdentifier.label} → ${targetIdentifier.label} 명시 관계`,
        block,
        relation.confidence,
        "동일 Markdown block의 단계·작업 ID와 관계 표현에서 직접 확인했습니다.",
      );
    }
  }

  for (const block of blocks) {
    if (block.id === rootBlock.id || block.type === "heading") continue;
    const ownerId = blockOwnerIds.get(block.id) ?? documentNodeId;
    for (const candidate of explicitEntitiesIn(block.text, { codeBlock: block.type === "code" })) {
      const entityId = candidate.semanticType === "technology"
        ? resolveEntityAlias(candidate.label)?.canonicalId ?? `technology:${stableKey(candidate.key)}`
        : candidate.semanticType === "api"
          ? `api:github:${sourceDescriptor.repositoryId}:${stableKey(candidate.key)}`
          : candidate.semanticType === "storage"
            ? `storage:github:${sourceDescriptor.repositoryId}:${stableKey(candidate.key)}`
            : candidate.semanticType === "file"
              ? `file:github:${sourceDescriptor.repositoryId}:${stableKey(candidate.key)}`
              : `${candidate.semanticType}:${documentId}:${stableKey(candidate.key)}`;
      const kind: NodeKind = candidate.semanticType === "api" || candidate.semanticType === "technology"
        ? "tool"
        : candidate.semanticType === "storage"
          ? "system"
          : candidate.semanticType === "file"
            ? "tool"
            : "practice";
      const entity = addNode(makeNode({
        id: entityId,
        label: candidate.label,
        summary: `${candidate.semanticType} 명시 엔티티입니다.`,
        kind,
        tags: [candidate.semanticType, `ontology:${candidate.semanticType}`, "explicit", profile],
      }), block);
      if (!entity) continue;
      const source = candidate.direction === "owner-to-entity" ? ownerId : entity.id;
      const target = candidate.direction === "owner-to-entity" ? entity.id : ownerId;
      addEdge(
        source,
        target,
        candidate.relation,
        `${candidate.semanticType} 명시 표현: ${candidate.label}`,
        block,
        candidate.confidence,
        "동일한 GitHub Markdown block의 코드·경로·명령 표현에서 직접 확인된 관계입니다.",
      );
    }
  }

  const linkNodes: AstNode[] = [];
  visit(root, "link", (rawNode: unknown) => {
    linkNodes.push(rawNode as AstNode);
  });
  for (const node of linkNodes) {
    const label = textOf(node).trim() || String(node.url ?? "");
    const block = containingBlockFor(node);
    const ownerId = blockOwnerIds.get(block.id) ?? documentNodeId;
    const repositoryLink = resolveRepositoryMarkdownLink(node.url, sourceDescriptor.relativePath);
    if (repositoryLink) {
      if (repositoryLink.kind === "anchor") {
        const targetSectionId = repositoryLink.anchor
          ? headingNodeBySlug.get(repositoryLink.anchor)
          : undefined;
        if (targetSectionId) {
          addEdge(
            ownerId,
            targetSectionId,
            "references",
            `동일 문서 heading 참조: #${repositoryLink.anchor}`,
            block,
            0.99,
            "동일 GitHub Markdown 문서의 heading anchor 링크에서 직접 확인된 참조입니다.",
          );
        }
        continue;
      }
      if (repositoryLink.kind === "document") {
        const targetDocumentId = `document-${await sha256(`github:${sourceDescriptor.repositoryId}:${repositoryLink.relativePath}`)}`;
        const targetNodeId = `document:${targetDocumentId}`;
        const target = addNode(makeNode({
          id: targetNodeId,
          label: repositoryLink.relativePath,
          summary: `${sourceDescriptor.repositoryName} 저장소의 연결된 Markdown 문서입니다.`,
          kind: "system",
          tags: ["document", "linked-document", profile, repositoryLink.relativePath],
        }), block);
        if (target) {
          addEdge(
            ownerId,
            target.id,
            "references",
            `동일 저장소 Markdown 참조: ${repositoryLink.relativePath}`,
            block,
            0.99,
            "동일 GitHub 저장소의 수집 대상 Markdown 상대 링크에서 직접 확인된 참조입니다.",
          );
        }
        continue;
      }
      const targetFileId = `file:github:${sourceDescriptor.repositoryId}:${stableKey(repositoryLink.relativePath)}`;
      const target = addNode(makeNode({
        id: targetFileId,
        label: repositoryLink.relativePath,
        summary: `${sourceDescriptor.repositoryName} 저장소의 명시적 파일 참조입니다.`,
        kind: "tool",
        tags: ["file", "linked-file", profile, repositoryLink.relativePath],
      }), block);
      if (target) {
        addEdge(
          ownerId,
          target.id,
          "references",
          `동일 저장소 파일 참조: ${repositoryLink.relativePath}`,
          block,
          0.98,
          "동일 GitHub 저장소의 상대 파일 링크에서 직접 확인된 참조입니다.",
        );
      }
      continue;
    }

    const url = normalizedReferenceUrl(node.url);
    if (!url) continue;
    const referenceId = `reference:${stableKey(url)}`;
    addNode(makeNode({
      id: referenceId,
      label,
      summary: url,
      kind: "tool",
      tags: ["reference", "url", "shared"],
    }), block);
    addEdge(ownerId, referenceId, "references", `외부 Markdown 링크: ${url}`, block, 0.95);
  }

  const structuralTypes = new Set<RelationKind>(["documents", "plans", "contains"]);
  const nodeScore = (node: KnowledgeNode) => {
    if ([repositoryNodeId, documentNodeId, planNodeId].includes(node.id)) return 10_000;
    if (node.tags.some((tag) => ["api", "storage", "technology", "file", "test", "risk", "decision", "identifier"].includes(tag))) return 900;
    if (node.tags.includes("phase")) return 760;
    if (node.tags.includes("task")) return 680;
    if (node.tags.includes("feature")) return 620;
    if (node.tags.includes("section")) return 420;
    if (node.tags.includes("reference")) return 300;
    return 500;
  };
  const blockOrdinal = new Map(blocks.map((block) => [block.id, block.ordinal]));
  const budgetedNodes = [...nodes].sort((left, right) =>
    nodeScore(right) - nodeScore(left)
    || (blockOrdinal.get(nodeBlockIds[left.id]) ?? 0) - (blockOrdinal.get(nodeBlockIds[right.id]) ?? 0)
    || left.id.localeCompare(right.id)).slice(0, 220);
  const budgetedNodeIds = new Set(budgetedNodes.map((node) => node.id));
  const budgetedEdges = edges.filter((edge) =>
    budgetedNodeIds.has(edge.source) && budgetedNodeIds.has(edge.target))
    .sort((left, right) =>
      Number(structuralTypes.has(left.type)) - Number(structuralTypes.has(right.type))
      || right.confidence - left.confidence
      || `${left.source}|${left.target}|${left.type}`.localeCompare(`${right.source}|${right.target}|${right.type}`))
    .slice(0, 540);
  const budgetedBlockIds: Record<string, string> = {};
  const budgetedEvidence: Record<string, NodeEvidence> = {};
  for (const node of budgetedNodes) {
    budgetedBlockIds[node.id] = nodeBlockIds[node.id];
    budgetedEvidence[node.id] = nodeEvidence[node.id];
  }
  return {
    nodes: budgetedNodes,
    edges: budgetedEdges,
    blocks,
    nodeBlockIds: budgetedBlockIds,
    nodeEvidence: budgetedEvidence,
  };
}

export async function extractGraphForSource(
  root: Root,
  context: ProfiledExtractionContext,
): Promise<ExtractedGraph> {
  const profile = selectMarkdownParserProfile(context.sourceDescriptor);
  if (profile === "generic") return extractGraph(root, context.documentId, context.fileName);
  return extractGitHubProfile(
    root,
    context as ProfiledExtractionContext & { sourceDescriptor: GitHubDocumentSourceDescriptor },
    profile,
  );
}
