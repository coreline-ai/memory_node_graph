import type { RelationKind } from "../../graph-data";

export type RepositoryMarkdownLink = {
  kind: "anchor" | "document" | "file";
  relativePath: string;
  anchor?: string;
};

export type ExplicitEntityType =
  | "api"
  | "file"
  | "storage"
  | "technology"
  | "command"
  | "test"
  | "phase"
  | "task";

export type ExplicitEntityCandidate = {
  semanticType: ExplicitEntityType;
  key: string;
  label: string;
  relation: RelationKind;
  direction: "owner-to-entity" | "entity-to-owner";
  confidence: number;
};

export type ExplicitIdentifierCandidate = {
  kind: "phase" | "task";
  key: string;
  label: string;
  raw: string;
};

export type ExplicitIdentifierRelation = {
  sourceKey: string;
  targetKey: string;
  relation: Extract<RelationKind, "precedes" | "depends_on" | "requires" | "blocks" | "references">;
  confidence: number;
};

const MARKDOWN_DOCUMENT_PATTERN = /^(?:README\.md|dev-plan\/(?:[^/]+\/)*[^/]+\.md)$/i;
const FILE_EXTENSION_PATTERN = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|rs|go|java|kt|swift|yaml|yml|toml|css|scss|html)$/i;
const KNOWN_FILE_PATTERN = /^(?:README\.md|package\.json|tsconfig\.json|wrangler\.toml|\.env(?:\.[A-Za-z0-9_.-]+)?)$/i;
const COMMAND_PATTERN = /^(?:npm|pnpm|yarn|bun|npx|node|python3?|pytest|gh|git|docker(?:-compose)?|wrangler|curl)\b/i;
const TEST_COMMAND_PATTERN = /(?:^|\s)(?:test|tests|lint|typecheck|check|pytest|tsc)(?:\s|$)|\bnpx\s+tsc\b/i;

const PHASE_IDENTIFIER_PATTERN = /\b(?:Phase\s*\d+(?:[-.]?[A-Z0-9]+)*|P\d+(?:-[A-Z0-9]+)+)\b/giu;
const TASK_IDENTIFIER_PATTERN = /\b(?:DEV|TASK|ISSUE|EPIC|MILESTONE)-\d{2,}\b/giu;

const normalizeIdentifier = (raw: string): ExplicitIdentifierCandidate => {
  const compact = raw.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase();
  if (/^PHASE\s*/.test(compact)) {
    const suffix = compact.replace(/^PHASE\s*/, "").replace(/\./g, "-");
    return { kind: "phase", key: `phase:${suffix}`, label: `Phase ${suffix}`, raw };
  }
  if (/^P\d/.test(compact)) {
    const suffix = compact.slice(1);
    return { kind: "phase", key: `phase:${suffix}`, label: `P${suffix}`, raw };
  }
  return { kind: "task", key: `task:${compact}`, label: compact, raw };
};

export function explicitIdentifiersIn(value: string): ExplicitIdentifierCandidate[] {
  const found = new Map<string, ExplicitIdentifierCandidate>();
  for (const pattern of [PHASE_IDENTIFIER_PATTERN, TASK_IDENTIFIER_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
      const candidate = normalizeIdentifier(match[0]);
      found.set(candidate.key, candidate);
    }
  }
  return [...found.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function explicitIdentifierRelationsIn(value: string): ExplicitIdentifierRelation[] {
  const identifiers = explicitIdentifiersIn(value).sort((left, right) =>
    value.indexOf(left.raw) - value.indexOf(right.raw) || left.key.localeCompare(right.key));
  if (identifiers.length < 2) return [];
  const normalized = value.normalize("NFKC");
  let relation: ExplicitIdentifierRelation["relation"] = "references";
  let confidence = 0.91;
  if (/(?:→|->|=>|이후|다음|후속|before|then|followed by|precedes)/iu.test(normalized)) {
    relation = "precedes";
    confidence = 0.96;
  } else if (/(?:의존|depends?\s+on|dependency)/iu.test(normalized)) {
    relation = "depends_on";
    confidence = 0.95;
  } else if (/(?:선행|필요|요구|requires?|prerequisite)/iu.test(normalized)) {
    relation = "requires";
    confidence = 0.94;
  } else if (/(?:차단|막(?:는|음)|blocks?)/iu.test(normalized)) {
    relation = "blocks";
    confidence = 0.94;
  }
  return identifiers.slice(0, -1).map((source, index) => ({
    sourceKey: source.key,
    targetKey: identifiers[index + 1].key,
    relation,
    confidence,
  }));
}

export function relationFromExplicitContext(
  value: string,
  fallback: RelationKind,
): RelationKind {
  if (/(?:완화|방지|해소|mitigates?|prevents?|addresses?)/iu.test(value)) return "mitigates";
  if (/(?:생성|산출|출력|produces?|generates?|outputs?)/iu.test(value)) return "produces";
  if (/(?:테스트|검증|검수|tests?|verifies?|validates?)/iu.test(value)) return "tests";
  if (/(?:호출|요청|calls?|invokes?)/iu.test(value)) return "calls";
  if (/(?:의존|depends?\s+on|dependency)/iu.test(value)) return "depends_on";
  if (/(?:필요|요구|requires?|prerequisite)/iu.test(value)) return "requires";
  if (/(?:저장|기록|쓰기|stores?|writes?|persists?)/iu.test(value)) return "writes_to";
  if (/(?:사용|활용|적용|uses?|utili[sz]es?)/iu.test(value)) return "uses";
  return fallback;
}

const decodeLinkPart = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeRepositoryPath = (currentPath: string, targetPath: string) => {
  const base = targetPath.startsWith("/")
    ? []
    : currentPath.split("/").slice(0, -1);
  const segments = [...base, ...targetPath.split("/")];
  const normalized: string[] = [];
  for (const rawSegment of segments) {
    const segment = decodeLinkPart(rawSegment).trim();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!normalized.length) return null;
      normalized.pop();
      continue;
    }
    if (segment.includes("\\") || segment.includes("/")) return null;
    normalized.push(segment);
  }
  return normalized.join("/");
};

export function githubHeadingSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function resolveRepositoryMarkdownLink(
  rawValue: unknown,
  currentPath: string,
): RepositoryMarkdownLink | null {
  if (typeof rawValue !== "string") return null;
  const value = rawValue.trim();
  if (!value || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  const hashIndex = value.indexOf("#");
  const queryIndex = value.indexOf("?");
  const pathEnd = [hashIndex, queryIndex].filter((index) => index >= 0)
    .reduce((minimum, index) => Math.min(minimum, index), value.length);
  const rawPath = value.slice(0, pathEnd);
  const rawAnchor = hashIndex >= 0
    ? value.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined)
    : "";
  const targetPath = rawPath
    ? normalizeRepositoryPath(currentPath, rawPath)
    : currentPath;
  if (!targetPath) return null;
  const anchor = rawAnchor ? githubHeadingSlug(decodeLinkPart(rawAnchor)) : undefined;

  if (targetPath === currentPath && anchor) {
    return { kind: "anchor", relativePath: targetPath, anchor };
  }
  if (MARKDOWN_DOCUMENT_PATTERN.test(targetPath)) {
    return { kind: "document", relativePath: targetPath, ...(anchor ? { anchor } : {}) };
  }
  if (FILE_EXTENSION_PATTERN.test(targetPath) || KNOWN_FILE_PATTERN.test(targetPath)) {
    return { kind: "file", relativePath: targetPath, ...(anchor ? { anchor } : {}) };
  }
  return null;
}

const relationForStorageContext = (value: string): RelationKind => {
  if (/\b(?:select|from|join|read|fetch|load)\b|조회|읽|불러오|가져오/i.test(value)) return "reads_from";
  if (/\b(?:insert|update|delete|write|store|save|upsert)\b|저장|쓰기|갱신|삭제/i.test(value)) return "writes_to";
  return "uses";
};

const normalizeCommand = (value: string) => value
  .trim()
  .replace(/^[$>]\s*/, "")
  .replace(/\s+/g, " ");

const addCandidate = (
  candidates: ExplicitEntityCandidate[],
  seen: Set<string>,
  candidate: ExplicitEntityCandidate,
) => {
  const signature = `${candidate.semanticType}|${candidate.key}|${candidate.relation}|${candidate.direction}`;
  if (seen.has(signature)) return;
  seen.add(signature);
  candidates.push(candidate);
};

export function explicitEntitiesIn(
  value: string,
  options: { codeBlock?: boolean } = {},
) {
  const text = value.replace(/\r\n?/g, "\n").trim();
  const candidates: ExplicitEntityCandidate[] = [];
  const seen = new Set<string>();
  if (!text || text.length > 12_000) return candidates;

  const apiPattern = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+((?:https?:\/\/[^\s`"']+)?\/[A-Za-z0-9_./:{}?&=%+\-]*)/gi;
  for (const match of text.matchAll(apiPattern)) {
    const method = match[1].toUpperCase();
    let path = match[2];
    try {
      if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
    } catch {
      continue;
    }
    path = path.replace(/[),.;]+$/, "");
    if (!path.startsWith("/") || path === "/") continue;
    const label = `${method} ${path}`;
    addCandidate(candidates, seen, {
      semanticType: "api",
      key: label.toLowerCase(),
      label,
      relation: "calls",
      direction: "owner-to-entity",
      confidence: 0.96,
    });
  }

  const pathPattern = /(?:^|[\s`'"(])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|rs|go|java|kt|swift|yaml|yml|toml|css|scss|html))(?=$|[^A-Za-z0-9_.-])/gi;
  for (const match of text.matchAll(pathPattern)) {
    const path = match[1].replace(/^\.\//, "");
    addCandidate(candidates, seen, {
      semanticType: "file",
      key: path,
      label: path,
      relation: "references",
      direction: "owner-to-entity",
      confidence: 0.95,
    });
  }
  const knownFilePattern = /(?:^|[\s`'"(])(README\.md|package\.json|tsconfig\.json|wrangler\.toml|\.env(?:\.[A-Za-z0-9_.-]+)?)(?=$|[^A-Za-z0-9_.-])/gi;
  for (const match of text.matchAll(knownFilePattern)) {
    const path = match[1];
    addCandidate(candidates, seen, {
      semanticType: "file",
      key: path,
      label: path,
      relation: "references",
      direction: "owner-to-entity",
      confidence: 0.95,
    });
  }

  const tablePattern = /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"[]?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const match of text.matchAll(tablePattern)) {
    const table = match[2];
    addCandidate(candidates, seen, {
      semanticType: "storage",
      key: `table:${table.toLowerCase()}`,
      label: `${table} table`,
      relation: relationForStorageContext(`${match[1]} ${text}`),
      direction: "owner-to-entity",
      confidence: 0.94,
    });
  }
  const koreanTablePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*테이블(?:에|을|에서|로|의)?/g;
  for (const match of text.matchAll(koreanTablePattern)) {
    const table = match[1];
    addCandidate(candidates, seen, {
      semanticType: "storage",
      key: `table:${table.toLowerCase()}`,
      label: `${table} table`,
      relation: relationForStorageContext(text),
      direction: "owner-to-entity",
      confidence: 0.92,
    });
  }

  const packagePattern = /(^|[^A-Za-z0-9_.-])(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?=$|[^A-Za-z0-9_.-])/g;
  for (const match of text.matchAll(packagePattern)) {
    const packageName = match[2];
    addCandidate(candidates, seen, {
      semanticType: "technology",
      key: packageName.toLowerCase(),
      label: packageName,
      relation: relationFromExplicitContext(
        text,
        /\b(?:install|add|dependency|requires?)\b|설치|의존/i.test(text) ? "depends_on" : "uses",
      ),
      direction: "owner-to-entity",
      confidence: 0.94,
    });
  }
  const installPattern = /\b(?:npm\s+(?:install|i)|pnpm\s+add|yarn\s+add|bun\s+add)\s+([^\n;&|]+)/gi;
  for (const match of text.matchAll(installPattern)) {
    for (const rawToken of match[1].trim().split(/\s+/)) {
      if (!rawToken || rawToken.startsWith("-") || /^(?:https?:|git\+|file:|\.{0,2}\/)/i.test(rawToken)) continue;
      let packageName = rawToken.replace(/[,;]+$/, "");
      if (packageName.startsWith("@")) {
        const versionIndex = packageName.indexOf("@", packageName.indexOf("/") + 1);
        if (versionIndex > 0) packageName = packageName.slice(0, versionIndex);
      } else {
        packageName = packageName.split("@")[0];
      }
      if (!/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(packageName)) continue;
      addCandidate(candidates, seen, {
        semanticType: "technology",
        key: packageName.toLowerCase(),
        label: packageName,
        relation: "depends_on",
        direction: "owner-to-entity",
        confidence: 0.97,
      });
    }
  }

  const commandLines = options.codeBlock ? text.split("\n") : [text];
  for (const line of commandLines) {
    const command = normalizeCommand(line);
    if (!COMMAND_PATTERN.test(command) || command.length > 180) continue;
    const testCommand = TEST_COMMAND_PATTERN.test(command);
    addCandidate(candidates, seen, {
      semanticType: testCommand ? "test" : "command",
      key: command.toLowerCase(),
      label: command,
      relation: testCommand ? "tests" : "references",
      direction: testCommand ? "entity-to-owner" : "owner-to-entity",
      confidence: testCommand ? 0.97 : 0.92,
    });
  }

  return candidates.sort((left, right) =>
    left.semanticType.localeCompare(right.semanticType)
      || left.key.localeCompare(right.key)
      || left.relation.localeCompare(right.relation));
}
