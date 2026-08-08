import type { KnowledgeNode } from "../../graph-data";
import type { DocumentBlock } from "../markdown/extract-graph";

/**
 * A deterministic, evidence-local reference to a possible relationship
 * endpoint. Unresolved anchors are intentionally retained for review but can
 * never make a Codex candidate executable.
 */
export type SemanticAnchorKind =
  | "component"
  | "api"
  | "file"
  | "technology"
  | "storage"
  | "phase"
  | "task"
  | "workflow"
  | "test"
  | "feature"
  | "data"
  | "decision"
  | "risk";

export type SemanticAnchorScope = "same_document" | "shared_technology" | "unresolved";
export type SemanticAnchorSource = "node_label" | "explicit_token" | "identifier";

export type SemanticAnchor = {
  nodeId?: string;
  label: string;
  normalized: string;
  kind: SemanticAnchorKind;
  scope: SemanticAnchorScope;
  blockId: string;
  matchText: string;
  source: SemanticAnchorSource;
  confidence: number;
};

export type SemanticAnchorResolverInput = {
  nodes: readonly KnowledgeNode[];
  blocks: readonly Pick<DocumentBlock, "id" | "text" | "type" | "ordinal">[];
};

const excludedEndpointTags = new Set(["document", "repository", "section", "heading", "plan", "reference"]);
const endpointKinds = new Set<SemanticAnchorKind>([
  "component",
  "api",
  "file",
  "technology",
  "storage",
  "phase",
  "task",
  "workflow",
  "test",
  "feature",
  "data",
  "decision",
  "risk",
]);
const genericLabels = new Set([
  "목표", "개요", "범위", "배경", "결론", "요약", "상태", "참조 문서", "구현 태스크", "자체 테스트", "완료 조건", "qa 관점",
  "goal", "overview", "scope", "background", "summary", "status", "changelog", "release notes",
]);
const componentSuffix = /_(?:proxy|service|worker|client|server|engine|renderer|router|store)$/i;
const componentToken = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi;
const apiToken = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:https?:\/\/[^\s`"']+)?\/[A-Za-z0-9_./:{}?&=%+\-]*)/gi;
const fileToken = /(?:^|[\s`'"(])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|rs|go|java|kt|swift|yaml|yml|toml|css|scss|html))(?=$|[^A-Za-z0-9_.-])/gi;
const packageToken = /(^|[^A-Za-z0-9_.-])(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[^A-Za-z0-9_.-])/g;
const phaseToken = /\b(?:Phase\s*\d+(?:[-.]?[A-Z0-9]+)*|P\d+(?:-[A-Z0-9]+)+)\b/giu;
const taskToken = /\b(?:DEV|TASK|ISSUE|EPIC|MILESTONE)-\d{2,}\b/giu;

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
const canonicalToken = (value: string) => normalize(value)
  .toLocaleLowerCase("en-US")
  .replace(/[^\p{L}\p{N}]+/gu, "");
const comparableLabel = (value: string) => normalize(value)
  .replace(/[`*_#>|]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .toLocaleLowerCase("en-US");

const boundaryPattern = (value: string) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu");
};

export function semanticAnchorKindForNode(node: KnowledgeNode): SemanticAnchorKind | null {
  const tags = new Set(node.tags.map((tag) => tag.toLocaleLowerCase("en-US")));
  if ([...excludedEndpointTags].some((tag) => tags.has(tag))) return null;
  for (const kind of endpointKinds) if (tags.has(kind)) return kind;
  return null;
}

export function isSemanticRelationshipEndpoint(node: KnowledgeNode) {
  return semanticAnchorKindForNode(node) !== null;
}

const scopeForNode = (node: KnowledgeNode, kind: SemanticAnchorKind): SemanticAnchorScope =>
  kind === "technology" && node.tags.some((tag) => tag.toLocaleLowerCase("en-US") === "shared")
    ? "shared_technology"
    : "same_document";

type RawAnchor = Pick<SemanticAnchor, "label" | "normalized" | "kind" | "matchText" | "source" | "confidence">;

const rawAnchorsIn = (text: string): RawAnchor[] => {
  const found = new Map<string, RawAnchor>();
  const add = (anchor: RawAnchor) => {
    const key = `${anchor.kind}|${anchor.normalized}`;
    if (!found.has(key)) found.set(key, anchor);
  };
  const normalizedText = normalize(text);
  for (const match of normalizedText.matchAll(apiToken)) {
    const path = match[1].replace(/[),.;]+$/, "");
    if (!path || path === "/") continue;
    const method = match[0].trim().split(/\s+/, 1)[0].toUpperCase();
    const label = `${method} ${path}`;
    add({ label, normalized: comparableLabel(label), kind: "api", matchText: label, source: "explicit_token", confidence: 0.98 });
  }
  for (const match of normalizedText.matchAll(fileToken)) {
    const label = match[1].replace(/^\.\//, "");
    add({ label, normalized: comparableLabel(label), kind: "file", matchText: label, source: "explicit_token", confidence: 0.97 });
  }
  for (const match of normalizedText.matchAll(packageToken)) {
    const label = match[2];
    add({ label, normalized: comparableLabel(label), kind: "technology", matchText: label, source: "explicit_token", confidence: 0.96 });
  }
  for (const match of normalizedText.matchAll(componentToken)) {
    const label = match[0];
    if (!componentSuffix.test(label)) continue;
    add({ label, normalized: comparableLabel(label), kind: "component", matchText: label, source: "explicit_token", confidence: 0.94 });
  }
  for (const match of normalizedText.matchAll(phaseToken)) {
    const label = normalize(match[0]);
    add({ label, normalized: comparableLabel(label), kind: "phase", matchText: label, source: "identifier", confidence: 0.98 });
  }
  for (const match of normalizedText.matchAll(taskToken)) {
    const label = normalize(match[0]).toUpperCase();
    add({ label, normalized: comparableLabel(label), kind: "task", matchText: label, source: "identifier", confidence: 0.98 });
  }
  return [...found.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.normalized.localeCompare(right.normalized)
    || left.label.localeCompare(right.label));
};

const matchesNode = (raw: RawAnchor, node: KnowledgeNode, kind: SemanticAnchorKind) => {
  const label = comparableLabel(node.label || node.shortLabel);
  if (!label) return false;
  if (raw.normalized === label) return true;
  // Shared technology labels may normalize package punctuation differently
  // (for example @openai/codex-sdk → OpenAI Codex SDK), never apply this
  // broader comparison to source-local components.
  return kind === "technology" && canonicalToken(raw.label) === canonicalToken(node.label || node.shortLabel);
};

const nodeAnchorsIn = (nodes: readonly KnowledgeNode[], text: string): RawAnchor[] => {
  const normalizedText = normalize(text);
  const found = new Map<string, RawAnchor>();
  for (const node of nodes) {
    const kind = semanticAnchorKindForNode(node);
    if (!kind) continue;
    const label = normalize(node.label || node.shortLabel);
    if (label.length < 3 || genericLabels.has(comparableLabel(label))) continue;
    if (!boundaryPattern(label).test(normalizedText)) continue;
    const anchor: RawAnchor = {
      label,
      normalized: comparableLabel(label),
      kind,
      matchText: label,
      source: "node_label",
      confidence: 0.99,
    };
    const key = `${anchor.kind}|${anchor.normalized}`;
    if (!found.has(key)) found.set(key, anchor);
  }
  return [...found.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind)
    || left.normalized.localeCompare(right.normalized)
    || left.label.localeCompare(right.label));
};

/**
 * Resolves only exact evidence-local references. The function is pure and
 * intentionally keeps unresolved anchors: they explain review candidates but
 * cannot be selected for Codex execution because nodeId is absent.
 */
export function resolveSemanticAnchors(input: SemanticAnchorResolverInput): SemanticAnchor[] {
  const endpointNodes = input.nodes
    .map((node) => ({ node, kind: semanticAnchorKindForNode(node) }))
    .filter((item): item is { node: KnowledgeNode; kind: SemanticAnchorKind } => item.kind !== null)
    .sort((left, right) => left.node.id.localeCompare(right.node.id));
  const anchors: SemanticAnchor[] = [];
  for (const block of [...input.blocks].sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))) {
    const rawAnchors = [...rawAnchorsIn(block.text), ...nodeAnchorsIn(endpointNodes.map((item) => item.node), block.text)];
    const seen = new Set<string>();
    for (const raw of rawAnchors) {
      const resolved = endpointNodes.find((item) => item.kind === raw.kind && matchesNode(raw, item.node, item.kind))
        ?? (raw.kind === "technology"
          ? endpointNodes.find((item) => item.kind === "technology" && matchesNode(raw, item.node, item.kind))
          : undefined);
      const anchor: SemanticAnchor = resolved
        ? {
          ...raw,
          nodeId: resolved.node.id,
          label: resolved.node.label,
          normalized: comparableLabel(resolved.node.label),
          kind: resolved.kind,
          scope: scopeForNode(resolved.node, resolved.kind),
          confidence: Math.max(raw.confidence, raw.source === "node_label" ? 0.99 : 0.96),
          blockId: block.id,
        }
        : {
          ...raw,
          scope: "unresolved",
          blockId: block.id,
        };
      const key = `${anchor.blockId}|${anchor.nodeId ?? "unresolved"}|${anchor.kind}|${anchor.normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push(anchor);
    }
  }
  return anchors.sort((left, right) =>
    left.blockId.localeCompare(right.blockId)
    || Number(Boolean(right.nodeId)) - Number(Boolean(left.nodeId))
    || right.confidence - left.confidence
    || left.kind.localeCompare(right.kind)
    || left.label.localeCompare(right.label)
    || (left.nodeId ?? "").localeCompare(right.nodeId ?? ""));
}

export const anchorsForBlock = (anchors: readonly SemanticAnchor[], blockId: string) =>
  anchors.filter((anchor) => anchor.blockId === blockId);
