import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveLocalD1Database } from "./lib/local-d1.mjs";

const CONTENT_CATEGORIES = Object.freeze([
  "current-architecture",
  "feature",
  "component",
  "workflow",
  "api-data-file",
  "technology",
  "decision",
  "risk",
  "test",
  "history",
  "superseded",
  "boilerplate",
  "ambiguous",
]);

const CATEGORY_RULES = Object.freeze([
  ["superseded", /(?:폐기|대체됨|대체되었|제거됨|더 이상 사용|deprecated|superseded|obsolete|legacy only)/iu],
  ["risk", /(?:위험|리스크|문제점|제약|한계|실패|오류|장애|취약|보안|주의|issue|risk|failure|error|limitation|constraint|security)/iu],
  ["decision", /(?:결정|선택 이유|채택|권장|원칙|근거|트레이드오프|trade[ -]?off|decision|rationale|recommend|chosen|adopt)/iu],
  ["test", /(?:테스트|검증|검수|회귀|품질|빌드|스모크|성능 측정|benchmark|\bqa\b|test|verify|validation|lint|build|smoke|coverage)/iu],
  ["current-architecture", /(?:현재 구조|현재 아키텍처|시스템 구조|구성도|처리 구조|데이터 흐름|아키텍처|architecture|system design|data flow)/iu],
  ["feature", /(?:주요 기능|핵심 기능|기능 목록|사용자 기능|feature|capabilit|지원 기능)/iu],
  ["workflow", /(?:처리 흐름|동작 방식|실행 순서|작업 순서|워크플로|파이프라인|단계별|workflow|pipeline|process flow|execution flow)/iu],
  ["api-data-file", /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\bapi\b|endpoint|엔드포인트|데이터베이스|스키마|테이블|저장소|파일 경로|database|schema|table|storage|\.tsx?\b|\.jsx?\b|\.sql\b|\.json\b|\.md\b)/iu],
  ["component", /(?:컴포넌트|모듈|서비스|커넥터|렌더러|리포지토리|어댑터|워커|클라이언트|서버|component|module|service|connector|renderer|repository|adapter|worker|client|server)/iu],
  ["technology", /(?:기술 스택|사용 기술|프레임워크|라이브러리|패키지|런타임|technology|tech stack|framework|library|package|runtime)/iu],
  ["history", /(?:진행 기록|실행 기록|변경 이력|완료 내역|작업 이력|업데이트 기록|changelog|release notes|implementation log|completed on)/iu],
]);

const BOILERPLATE_HEADINGS = new Set([
  "개요", "목표", "개발 목적", "구현 태스크", "구현 작업", "자체 테스트", "테스트",
  "완료 조건", "이슈 및 수정", "현재 상태", "진행 규칙", "예상 변경 파일", "영향 범위",
  "overview", "goal", "tasks", "implementation tasks", "tests", "completion criteria",
  "issues", "current status", "scope", "out of scope",
]);

const TECHNOLOGIES = Object.freeze([
  ["Android", /\bandroid\b/iu],
  ["Cloudflare D1", /\b(?:cloudflare\s+)?d1\b/iu],
  ["Cloudflare Workers", /\bcloudflare\s+workers?\b/iu],
  ["Codex SDK", /\b(?:openai\s+)?codex(?:\s+sdk)?\b/iu],
  ["Docker", /\bdocker(?:-compose)?\b/iu],
  ["Drizzle ORM", /\bdrizzle(?:\s+orm)?\b/iu],
  ["FFmpeg", /\bffmpeg\b/iu],
  ["GitHub CLI", /\bgithub\s+cli\b|\bgh\s+(?:auth|repo|api)\b/iu],
  ["GraphRAG", /\bgraphrag\b/iu],
  ["Kotlin", /\bkotlin\b/iu],
  ["LightRAG", /\blightrag\b/iu],
  ["Neo4j", /\bneo4j\b/iu],
  ["Next.js", /\bnext(?:\.js|js)\b/iu],
  ["Node.js", /\bnode(?:\.js|js)\b/iu],
  ["OpenAI", /\bopenai\b/iu],
  ["Playwright", /\bplaywright\b/iu],
  ["PostgreSQL", /\bpostgres(?:ql)?\b/iu],
  ["Python", /\bpython\b/iu],
  ["React", /\breact(?:\.js|js)?\b/iu],
  ["Redis", /\bredis\b/iu],
  ["Remark", /\bremark\b/iu],
  ["Remotion", /\bremotion\b/iu],
  ["SQLite", /\bsqlite\b/iu],
  ["Supabase", /\bsupabase\b/iu],
  ["Tailwind CSS", /\btailwind(?:\s+css)?\b/iu],
  ["Three.js", /\bthree(?:\.js|js)\b/iu],
  ["TypeScript", /\btypescript\b/iu],
  ["Vite", /\bvite\b/iu],
  ["Vitest", /\bvitest\b/iu],
  ["WebGL", /\bwebgl\b/iu],
]);

const FILE_PATH_PATTERN = /(?:^|[\s`'"(])((?:[A-Za-z0-9_.@-]+\/)+(?:[A-Za-z0-9_.@-]+\.(?:tsx?|jsx?|mjs|cjs|py|kt|kts|java|go|rs|swift|sql|json|ya?ml|toml|mdx?|css|scss|html)))(?=$|[\s`'"),:])/giu;
const API_PATTERN = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_./:{}?=&-]*)/giu;
const PHASE_PATTERN = /\b(?:Phase\s*\d+(?:-[A-Z0-9]+)?|P\d+(?:-[A-Z0-9]+)?|DEV-\d{2,})\b/giu;
const COMPONENT_PATTERN = /\b([A-Z][A-Za-z0-9]*(?:Service|Connector|Repository|Renderer|Module|Worker|Client|Server|Engine|Manager|Controller|Gateway|Adapter))\b/gu;
const DATA_SYMBOL_PATTERN = /\b(?:CREATE\s+TABLE|FROM|JOIN|INSERT\s+INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/giu;
const COMMAND_PATTERN = /\b((?:npm|pnpm|bun|npx|pytest|python3?\s+-m\s+pytest|\.\/gradlew|gradle|flutter|cargo|go)\s+(?:run\s+)?(?:test|build|lint|check|analyze|assemble\w*|verify)(?:\s+--?[A-Za-z0-9_.=-]+)*)/giu;
const STATUS_PATTERN = /\b(completed|pending|blocked|failed|in[ -]?progress|cancelled)\b|(?:완료|대기|차단|실패|진행 중|취소됨)/giu;
const METRIC_PATTERN = /\b\d+(?:\.\d+)?\s*(?:ms|초|분|MB|GB|KB|%|FPS|tests?|개 테스트|tokens?|files?|문서|노드|관계)\b/giu;
const SECRET_PATTERN = /(?:gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})/giu;
const DATA_SYMBOL_STOPWORDS = new Set(["a", "an", "the", "this", "that", "it", "app", "run", "render", "helper", "compatibility", "pathlib"]);

function parseArguments(argv) {
  const options = {
    database: "",
    snapshot: "docs/knowledge-graph-corpus-snapshot-20260806.json",
    outputJson: "docs/knowledge-graph-corpus-analysis.json",
    outputMarkdown: "docs/knowledge-graph-corpus-analysis.md",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--database" && next) options.database = next;
    else if (value === "--snapshot" && next) options.snapshot = next;
    else if (value === "--output-json" && next) options.outputJson = next;
    else if (value === "--output-md" && next) options.outputMarkdown = next;
    else throw new Error(`알 수 없거나 값이 없는 인자입니다: ${value}`);
    index += 1;
  }
  return options;
}

async function atomicWrite(path, content) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, absolute);
}

function normalizeHeading(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^\s*(?:#+|[-*+]|\d+[.)]|\[[ xX]\])\s*/u, "")
    .replace(/[✨🚀📌✅❌⚠️🧪🔧📋🎯💡📊🗂️📝]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("ko-KR");
}

function sanitizeEvidence(value) {
  return String(value ?? "")
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 220);
}

export function classifyCorpusBlock(block) {
  if (block.type === "document") return { primary: "document-root", matches: ["document-root"] };
  const text = String(block.text ?? "");
  const normalized = normalizeHeading(text);
  const matches = [];
  if (block.type === "heading" && BOILERPLATE_HEADINGS.has(normalized)) matches.push("boilerplate");
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) matches.push(category);
  }
  if (matches.length === 0) return { primary: "ambiguous", matches: ["ambiguous"] };
  const primary = matches.find((category) => category !== "boilerplate") ?? "boilerplate";
  return { primary, matches: [...new Set(matches)] };
}

function addCandidate(map, label, documentId, documentHash, repositoryId, evidence) {
  const key = label.toLocaleLowerCase("en-US");
  const current = map.get(key) ?? {
    label,
    mentions: 0,
    documents: new Set(),
    documentHashes: new Set(),
    repositories: new Set(),
    evidence: [],
  };
  current.mentions += 1;
  current.documents.add(documentId);
  current.documentHashes.add(documentHash);
  current.repositories.add(repositoryId);
  if (current.evidence.length < 3 && evidence?.sourceUrl) {
    current.evidence.push({
      text: sanitizeEvidence(evidence.text),
      sourceUrl: evidence.sourceUrl,
    });
  }
  map.set(key, current);
}

function extractBlockCandidates(block, maps) {
  const text = String(block.text ?? "");
  for (const [label, pattern] of TECHNOLOGIES) {
    if (pattern.test(text)) addCandidate(maps.technologies, label, block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(FILE_PATH_PATTERN)) {
    const label = match[1];
    if (label.length <= 180) addCandidate(maps.files, label, block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(API_PATTERN)) {
    addCandidate(maps.apis, `${match[1].toUpperCase()} ${match[2]}`, block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(PHASE_PATTERN)) {
    addCandidate(maps.phases, match[0].replace(/\s+/gu, " "), block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(COMPONENT_PATTERN)) {
    addCandidate(maps.components, match[1], block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(DATA_SYMBOL_PATTERN)) {
    const label = match[1];
    if (
      !DATA_SYMBOL_STOPWORDS.has(label.toLocaleLowerCase("en-US"))
      && (block.type === "code" || label.includes("_") || /[A-Z]/u.test(label))
    ) addCandidate(maps.dataSymbols, label, block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(COMMAND_PATTERN)) {
    addCandidate(maps.testCommands, sanitizeEvidence(match[1]), block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(STATUS_PATTERN)) {
    addCandidate(maps.statuses, match[0].toLocaleLowerCase("ko-KR"), block.documentId, block.documentHash, block.repositoryId, block);
  }
  for (const match of text.matchAll(METRIC_PATTERN)) {
    addCandidate(maps.metrics, match[0], block.documentId, block.documentHash, block.repositoryId, block);
  }
}

function serializeCandidates(map, limit = 60) {
  return [...map.values()]
    .map((candidate) => ({
      label: candidate.label,
      mentions: candidate.mentions,
      documents: candidate.documents.size,
      uniqueContents: candidate.documentHashes.size,
      repositories: candidate.repositories.size,
      evidence: candidate.evidence,
    }))
    .sort((left, right) =>
      right.repositories - left.repositories
      || right.uniqueContents - left.uniqueContents
      || right.documents - left.documents
      || right.mentions - left.mentions
      || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function databaseFingerprint(database) {
  const documents = database.prepare(`
    SELECT id, hash, commit_sha commitSha, size, node_count nodeCount, edge_count edgeCount
    FROM documents WHERE source_type = 'github' ORDER BY id
  `).all();
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents WHERE source_type = 'github') documents,
      (SELECT COUNT(*) FROM document_blocks b JOIN documents d ON d.id = b.document_id WHERE d.source_type = 'github') blocks,
      (SELECT COUNT(*) FROM entities) entities,
      (SELECT COUNT(*) FROM relations) relations,
      (SELECT COUNT(*) FROM enrichment_jobs) enrichmentJobs
  `).get();
  return {
    ...counts,
    documentDigest: sha256(JSON.stringify(documents)),
  };
}

class DisjointSet {
  constructor(ids) {
    this.parent = new Map(ids.map((id) => [id, id]));
    this.size = new Map(ids.map((id) => [id, 1]));
  }

  find(id) {
    let current = id;
    while (this.parent.get(current) !== current) current = this.parent.get(current);
    let cursor = id;
    while (this.parent.get(cursor) !== current) {
      const next = this.parent.get(cursor);
      this.parent.set(cursor, current);
      cursor = next;
    }
    return current;
  }

  union(left, right) {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.size.get(leftRoot) < this.size.get(rightRoot)) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    this.parent.set(rightRoot, leftRoot);
    this.size.set(leftRoot, this.size.get(leftRoot) + this.size.get(rightRoot));
  }
}

function analyzeGraph(database) {
  const entities = database.prepare("SELECT id, label, kind, domain FROM entities ORDER BY id").all();
  const entityIds = new Set(entities.map((entity) => entity.id));
  const disjointSet = new DisjointSet(entities.map((entity) => entity.id));
  const degrees = new Map(entities.map((entity) => [entity.id, 0]));
  const relationTypes = new Map();
  let relationCount = 0;
  let selfLoops = 0;
  let danglingSources = 0;
  let danglingTargets = 0;
  for (const relation of database.prepare("SELECT source_id sourceId, target_id targetId, type FROM relations").iterate()) {
    relationCount += 1;
    relationTypes.set(relation.type, (relationTypes.get(relation.type) ?? 0) + 1);
    if (!entityIds.has(relation.sourceId)) danglingSources += 1;
    if (!entityIds.has(relation.targetId)) danglingTargets += 1;
    if (!entityIds.has(relation.sourceId) || !entityIds.has(relation.targetId)) continue;
    if (relation.sourceId === relation.targetId) selfLoops += 1;
    degrees.set(relation.sourceId, degrees.get(relation.sourceId) + 1);
    degrees.set(relation.targetId, degrees.get(relation.targetId) + 1);
    disjointSet.union(relation.sourceId, relation.targetId);
  }
  const componentSizes = new Map();
  for (const entity of entities) {
    const root = disjointSet.find(entity.id);
    componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
  }
  const degreeValues = [...degrees.values()].sort((left, right) => left - right);
  const topDegree = entities.map((entity) => ({
    id: entity.id,
    label: entity.label,
    kind: entity.kind,
    domain: entity.domain,
    degree: degrees.get(entity.id),
  })).sort((left, right) => right.degree - left.degree || left.label.localeCompare(right.label)).slice(0, 30);
  const relationDistribution = [...relationTypes.entries()]
    .map(([type, count]) => ({ type, count, ratio: relationCount ? count / relationCount : 0 }))
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type));
  const duplicateEdgeGroups = database.prepare(`
    SELECT COUNT(*) groupsCount FROM (
      SELECT source_id, target_id, type, COUNT(*) count
      FROM relations GROUP BY source_id, target_id, type HAVING COUNT(*) > 1
    )
  `).get().groupsCount;
  return {
    entities: entities.length,
    relations: relationCount,
    averageDegree: entities.length ? (relationCount * 2) / entities.length : 0,
    medianDegree: degreeValues[Math.floor(degreeValues.length / 2)] ?? 0,
    degreeZero: degreeValues.filter((degree) => degree === 0).length,
    degreeOne: degreeValues.filter((degree) => degree === 1).length,
    degreeOneRatio: entities.length ? degreeValues.filter((degree) => degree === 1).length / entities.length : 0,
    connectedComponents: componentSizes.size,
    largestComponent: Math.max(0, ...componentSizes.values()),
    selfLoops,
    duplicateEdgeGroups,
    danglingSources,
    danglingTargets,
    relationDistribution,
    topDegree,
  };
}

function selectGoldCandidates(documents, repositoryRoles, limit = 12) {
  const scored = documents.map((document) => {
    const diversity = Object.values(document.classifications).filter((count) => count > 0).length;
    const bothRoles = repositoryRoles.get(document.repositoryId)?.size > 1;
    const score = diversity * 8
      + Math.log2(document.size + 1)
      + Math.min(document.nodeCount, 220) / 22
      + (bothRoles ? 6 : 0)
      + (document.role === "README" ? 5 : 0);
    return {
      documentId: document.documentId,
      repositoryId: document.repositoryId,
      repositoryName: document.repositoryName,
      relativePath: document.relativePath,
      role: document.role,
      size: document.size,
      blocks: document.blocks,
      nodes: document.nodeCount,
      edges: document.edgeCount,
      categoryDiversity: diversity,
      score: Number(score.toFixed(3)),
      reason: `${bothRoles ? "README·dev-plan 교차 검토 가능, " : ""}${diversity}개 정보 범주, ${document.blocks}개 블록`,
    };
  });
  const scoredByRepository = new Map();
  for (const candidate of scored) {
    const list = scoredByRepository.get(candidate.repositoryId) ?? [];
    list.push(candidate);
    scoredByRepository.set(candidate.repositoryId, list);
  }
  const selected = [];
  const selectedDocuments = new Set();
  const selectedHashes = new Set();
  const selectedRepositoryCounts = new Map();
  const add = (candidate, paired = false) => {
    const document = documents.find((item) => item.documentId === candidate.documentId);
    if (!document || selectedDocuments.has(candidate.documentId) || selectedHashes.has(document.hash)) return false;
    const repositoryCount = selectedRepositoryCounts.get(candidate.repositoryId) ?? 0;
    if ((!paired && repositoryCount > 0) || (paired && repositoryCount >= 2)) return false;
    selected.push({
      ...candidate,
      reason: paired
        ? `동일 저장소 README↔dev-plan 교차 검토 페어, ${candidate.categoryDiversity}개 정보 범주, ${candidate.blocks}개 블록`
        : candidate.reason,
    });
    selectedDocuments.add(candidate.documentId);
    selectedHashes.add(document.hash);
    selectedRepositoryCounts.set(candidate.repositoryId, repositoryCount + 1);
    return true;
  };
  const pairedRepositories = [...scoredByRepository.entries()]
    .map(([repositoryId, list]) => ({
      repositoryId,
      readme: list.filter((item) => item.role === "README").sort((left, right) => right.score - left.score)[0],
      devPlan: list.filter((item) => item.role === "dev-plan").sort((left, right) => right.score - left.score)[0],
    }))
    .filter((item) => item.readme && item.devPlan)
    .sort((left, right) => (right.readme.score + right.devPlan.score) - (left.readme.score + left.devPlan.score));
  let paired = 0;
  for (const repository of pairedRepositories) {
    const readmeDocument = documents.find((item) => item.documentId === repository.readme.documentId);
    const devPlanDocument = documents.find((item) => item.documentId === repository.devPlan.documentId);
    if (
      !readmeDocument
      || !devPlanDocument
      || readmeDocument.hash === devPlanDocument.hash
      || selectedHashes.has(readmeDocument.hash)
      || selectedHashes.has(devPlanDocument.hash)
    ) continue;
    if (!add(repository.readme, true) || !add(repository.devPlan, true)) {
      throw new Error(`Gold Graph 페어 선택 원자성이 깨졌습니다: ${repository.repositoryId}`);
    }
    paired += 1;
    if (paired >= 3) break;
  }
  for (const role of ["README", "dev-plan"]) {
    const roleLimit = role === "README" ? 5 : 7;
    for (const candidate of scored
      .filter((item) => item.role === role)
      .sort((left, right) => right.score - left.score || left.relativePath.localeCompare(right.relativePath))) {
      add(candidate);
      if (selected.filter((item) => item.role === role).length >= roleLimit) break;
    }
  }
  return selected.sort((left, right) => right.score - left.score).slice(0, limit);
}

function documentCandidateLabels(candidateMaps) {
  const byDocument = new Map();
  for (const [candidateType, candidates] of Object.entries(candidateMaps)) {
    for (const candidate of candidates.values()) {
      for (const documentId of candidate.documents) {
        const current = byDocument.get(documentId) ?? {};
        const labels = current[candidateType] ?? new Set();
        labels.add(candidate.label);
        current[candidateType] = labels;
        byDocument.set(documentId, current);
      }
    }
  }
  return byDocument;
}

function buildCrossDocumentPairs(documents, candidateMaps, limit = 100) {
  const labelsByDocument = documentCandidateLabels(candidateMaps);
  const byRepository = new Map();
  for (const document of documents) {
    const list = byRepository.get(document.repositoryId) ?? [];
    list.push(document);
    byRepository.set(document.repositoryId, list);
  }
  const pairs = [];
  for (const repositoryDocuments of byRepository.values()) {
    const readmes = repositoryDocuments.filter((document) => document.role === "README");
    const plans = repositoryDocuments.filter((document) => document.role === "dev-plan");
    for (const readme of readmes) {
      for (const plan of plans) {
        const readmeLabels = labelsByDocument.get(readme.documentId) ?? {};
        const planLabels = labelsByDocument.get(plan.documentId) ?? {};
        const shared = [];
        for (const type of ["technologies", "components", "files", "apis", "dataSymbols", "phases"]) {
          const right = planLabels[type] ?? new Set();
          for (const label of readmeLabels[type] ?? []) {
            if (right.has(label)) shared.push({ type, label });
          }
        }
        const signals = [];
        if (readme.classifications.feature && plan.classifications.test) signals.push("feature↔test");
        if (readme.classifications["current-architecture"] && (plan.classifications.component || plan.classifications["api-data-file"])) {
          signals.push("architecture↔implementation");
        }
        if (readme.classifications.risk && (plan.classifications.decision || plan.classifications.workflow)) signals.push("risk↔mitigation");
        if (readme.classifications.decision && (plan.classifications.history || plan.classifications.superseded)) signals.push("decision↔history");
        if (shared.length === 0 && signals.length === 0) continue;
        pairs.push({
          repositoryId: readme.repositoryId,
          repositoryName: readme.repositoryName,
          readme: { documentId: readme.documentId, relativePath: readme.relativePath, sourceUrl: readme.sourceUrl },
          devPlan: { documentId: plan.documentId, relativePath: plan.relativePath, sourceUrl: plan.sourceUrl },
          shared: shared.slice(0, 20),
          signals,
          score: shared.length * 5 + signals.length * 3,
        });
      }
    }
  }
  return pairs.sort((left, right) =>
    right.score - left.score
    || right.shared.length - left.shared.length
    || left.repositoryName.localeCompare(right.repositoryName)
    || left.devPlan.relativePath.localeCompare(right.devPlan.relativePath)).slice(0, limit);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(analysis) {
  const number = new Intl.NumberFormat("ko-KR");
  const categoryRows = CONTENT_CATEGORIES.map((category) => {
    const count = analysis.blocks.classifications[category] ?? 0;
    return `| ${category} | ${number.format(count)} | ${percent(count / analysis.blocks.contentBlocks)} |`;
  }).join("\n");
  const relationRows = analysis.graph.relationDistribution.map((item) =>
    `| ${item.type} | ${number.format(item.count)} | ${percent(item.ratio)} |`).join("\n");
  const candidateRows = analysis.goldGraphCandidates.map((item) =>
    `| ${item.repositoryName} | ${item.relativePath} | ${item.role} | ${item.categoryDiversity} | ${item.reason} |`).join("\n");
  const technologyRows = analysis.candidates.technologies.slice(0, 25).map((item) =>
    `| ${item.label} | ${number.format(item.repositories)} | ${number.format(item.documents)} | ${number.format(item.uniqueContents)} | ${number.format(item.mentions)} |`).join("\n");
  const repeatedRows = analysis.repeatedHeadings.slice(0, 25).map((item) =>
    `| ${item.label.replaceAll("|", "\\|")} | ${number.format(item.documents)} | ${number.format(item.repositories)} | ${number.format(item.occurrences)} | ${item.boilerplateCandidate ? "제외 후보" : "검토"} |`).join("\n");
  const duplicateLabelRows = analysis.candidates.duplicateLabels.slice(0, 15).map((item) =>
    `| ${item.exampleLabel.replaceAll("|", "\\|")} | ${number.format(item.entities)} |`).join("\n");
  const duplicateContentRows = analysis.duplicateContent.groups.slice(0, 15).map((item) =>
    `| ${item.hash.slice(0, 12)}… | ${number.format(item.documents)} | ${number.format(item.repositories)} | ${item.examples.map((example) => `${example.repositoryName}/${example.relativePath}`).join("<br>")} |`).join("\n");
  const sharedEntityRows = analysis.candidates.sharedEntities.slice(0, 20).map((item) =>
    `| ${item.label.replaceAll("|", "\\|")} | ${item.kind} | ${number.format(item.repositories)} | ${number.format(item.documents)} |`).join("\n");
  const crossPairRows = analysis.crossDocument.pairs.slice(0, 20).map((item) =>
    `| ${item.repositoryName} | ${item.devPlan.relativePath} | ${item.shared.slice(0, 6).map((candidate) => candidate.label).join(", ") || "-"} | ${item.signals.join(", ") || "-"} |`).join("\n");
  const candidateSummaryRows = [
    ["컴포넌트", analysis.candidates.components],
    ["API", analysis.candidates.apis],
    ["데이터 심볼", analysis.candidates.dataSymbols],
    ["파일 경로", analysis.candidates.files],
    ["Phase/Task ID", analysis.candidates.phases],
    ["테스트 명령", analysis.candidates.testCommands],
    ["상태", analysis.candidates.statuses],
    ["지표", analysis.candidates.metrics],
  ].map(([type, items]) => `| ${type} | ${items.slice(0, 10).map((item) => item.label.replaceAll("|", "\\|")).join(", ") || "-"} |`).join("\n");
  return [
    "# 다운로드 Markdown 전체 코퍼스 분석",
    "",
    `생성 시각: \`${analysis.generatedAt}\``,
    "",
    `분석 판정: **${analysis.audit.readOnlyPreserved && analysis.audit.completeCoverage ? "PASS" : "FAIL"}**`,
    "",
    "> 이 보고서는 현재 D1을 `query_only`로 열어 853개 Markdown 전체를 읽기 전용 분석한 결과다. 범주 분류와 후보 추출은 온톨로지 확정 전의 결정적 휴리스틱이며, 자동 지식 관계로 저장하지 않는다.",
    "",
    "## 핵심 결론",
    "",
    `- 111개 저장소의 Markdown ${number.format(analysis.corpus.documents)}개(README ${number.format(analysis.corpus.readme)}개·dev-plan ${number.format(analysis.corpus.devPlan)}개), ${number.format(analysis.corpus.bytes)} bytes를 분석했다.`,
    `- 전체 블록은 ${number.format(analysis.blocks.total)}개이며 문서 root를 제외한 내용 블록은 ${number.format(analysis.blocks.contentBlocks)}개다.`,
    `- 현재 그래프 관계 ${number.format(analysis.graph.relations)}개 중 \`contains\`가 ${percent(analysis.graph.relationDistribution.find((item) => item.type === "contains")?.ratio ?? 0)}로 구조 관계 편중이 매우 크다.`,
    `- 차수 1 노드는 ${number.format(analysis.graph.degreeOne)}개(${percent(analysis.graph.degreeOneRatio)})이고 연결 컴포넌트는 ${number.format(analysis.graph.connectedComponents)}개다. 관계 수만 늘리기보다 문서 간 공유 엔티티와 근거 있는 교차 관계가 필요하다.`,
    `- 반복 heading은 템플릿/이력 노드 과잉의 주원인이다. \`구현 태스크\`, \`완료 조건\`, \`자체 테스트\` 같은 공통 heading은 공용 지식 엔티티로 승격하지 않는 것이 안전하다.`,
    "- parser v3·Codex 계약을 바로 변경하지 않고 아래 Gold Graph 후보 문서에서 승격·제외·관계 방향을 먼저 검토해야 한다.",
    "",
    "## 코퍼스 정본",
    "",
    "| 항목 | 값 |",
    "|---|---:|",
    `| 저장소 | ${number.format(analysis.corpus.repositories)} |`,
    `| 문서 | ${number.format(analysis.corpus.documents)} |`,
    `| README | ${number.format(analysis.corpus.readme)} |`,
    `| dev-plan | ${number.format(analysis.corpus.devPlan)} |`,
    `| 고유 원문 hash | ${number.format(analysis.duplicateContent.uniqueHashes)} |`,
    `| 중복 원문 그룹 | ${number.format(analysis.duplicateContent.groupCount)} |`,
    `| 원문 bytes | ${number.format(analysis.corpus.bytes)} |`,
    `| 분석 블록 | ${number.format(analysis.blocks.total)} |`,
    `| 블록 문자 | ${number.format(analysis.blocks.characters)} |`,
    `| Markdown link reference | ${number.format(analysis.blocks.linkReferences)} |`,
    `| snapshot digest | \`${analysis.snapshotDigest}\` |`,
    "",
    "## 정보 범주 후보",
    "",
    "한 블록에 여러 신호가 있어도 가장 우선하는 범주 하나를 집계했다. `ambiguous`는 버리는 데이터가 아니라 Phase 3에서 승격 여부를 판단해야 하는 미분류 범위다.",
    "",
    "| 범주 | 블록 | 비율 |",
    "|---|---:|---:|",
    categoryRows,
    "",
    "## 현재 그래프 품질 기준선",
    "",
    "| 지표 | 값 |",
    "|---|---:|",
    `| 엔티티 | ${number.format(analysis.graph.entities)} |`,
    `| 관계 | ${number.format(analysis.graph.relations)} |`,
    `| 평균 차수 | ${analysis.graph.averageDegree.toFixed(3)} |`,
    `| 중앙 차수 | ${analysis.graph.medianDegree} |`,
    `| 차수 0 | ${number.format(analysis.graph.degreeZero)} |`,
    `| 차수 1 | ${number.format(analysis.graph.degreeOne)} (${percent(analysis.graph.degreeOneRatio)}) |`,
    `| 연결 컴포넌트 | ${number.format(analysis.graph.connectedComponents)} |`,
    `| 최대 컴포넌트 | ${number.format(analysis.graph.largestComponent)} |`,
    `| dangling source·target | ${analysis.graph.danglingSources} · ${analysis.graph.danglingTargets} |`,
    "",
    "### 관계 분포",
    "",
    "| 관계 | 수 | 비율 |",
    "|---|---:|---:|",
    relationRows,
    "",
    "## 중복 원문과 반복 라벨",
    "",
    `동일 SHA-256 원문을 공유하는 문서는 ${number.format(analysis.duplicateContent.documentsInGroups)}개이며 ${number.format(analysis.duplicateContent.groupCount)}개 그룹이다. 빈도·Gold Graph 표본은 같은 원문 hash를 중복 가중하지 않아야 한다.`,
    "",
    "| 원문 hash | 문서 | 저장소 | 예시 |",
    "|---|---:|---:|---|",
    duplicateContentRows,
    "",
    "현재 source-local 구조 노드는 같은 heading을 문서별로 분리하는 것이 맞지만, overview 공용 지식으로 그대로 승격하면 아래처럼 거대한 거짓 허브가 된다.",
    "",
    "| 동일 라벨 | source-local 엔티티 |",
    "|---|---:|",
    duplicateLabelRows,
    "",
    "## 반복 Heading과 템플릿 분리",
    "",
    "| Heading | 문서 | 저장소 | 출현 | 판정 |",
    "|---|---:|---:|---:|---|",
    repeatedRows,
    "",
    "## 교차 저장소 기술 후보",
    "",
    "| 기술 | 저장소 | 문서 | 고유 원문 | 언급 |",
    "|---|---:|---:|---:|---:|",
    technologyRows,
    "",
    "## 구조화 후보 표본",
    "",
    "| 후보 종류 | 빈도 상위 표본 |",
    "|---|---|",
    candidateSummaryRows,
    "",
    "## 교차 문서 관계 후보",
    "",
    `- README와 dev-plan을 모두 가진 저장소는 ${number.format(analysis.crossDocument.repositoriesWithBothRoles)}개다. 이 범위에서 현재 구조↔구현 계획, 기능↔테스트, 위험↔완화, 결정↔후속 결정 관계를 우선 검토한다.`,
    `- 둘 이상의 문서에서 mention된 기존 공유 엔티티는 ${number.format(analysis.crossDocument.sharedEntities)}개이며, 둘 이상의 저장소를 잇는 엔티티는 ${number.format(analysis.crossDocument.crossRepositoryEntities)}개다.`,
    `- 동일 정규화 라벨을 가진 source-local 엔티티 그룹은 ${number.format(analysis.crossDocument.duplicateLabelGroups)}개다. 라벨만으로 병합하지 않고 종류·근거·저장소 문맥을 함께 확인해야 한다.`,
    "",
    "| 공유 엔티티 | 종류 | 저장소 | 문서 |",
    "|---|---|---:|---:|",
    sharedEntityRows,
    "",
    "### README↔dev-plan 후보 페어",
    "",
    "| 저장소 | dev-plan | 공유 후보 | 관계 검토 신호 |",
    "|---|---|---|---|",
    crossPairRows,
    "",
    "## Gold Graph 표본 후보",
    "",
    "README와 dev-plan을 한 종류에 치우치지 않게 선택하고, 저장소를 중복하지 않으며 정보 범주 다양성·문서 크기·현재 구조 그래프 크기를 함께 반영했다.",
    "",
    "| 저장소 | 문서 | 역할 | 범주 다양성 | 선정 근거 |",
    "|---|---|---|---:|---|",
    candidateRows,
    "",
    "## Phase 3 승격·제외 기준 제안",
    "",
    "### 우선 승격 후보",
    "",
    "- 여러 문서나 저장소에서 반복 참조되고 독립적으로 설명 가능한 기술·컴포넌트·API·데이터 저장소",
    "- 명시적인 source와 target이 있으며 원문 line evidence로 역추적되는 의존·호출·입출력·테스트·위험 완화 관계",
    "- README의 현재 구조와 dev-plan의 실제 구현·검증 기록이 서로 일치하는 개념",
    "",
    "### 기본 제외 후보",
    "",
    "- `목표`, `구현 태스크`, `자체 테스트`, `완료 조건`, `이슈 및 수정`처럼 저장소마다 반복되는 문서 골격 heading",
    "- 날짜·상태만 다른 과거 진행 기록, 체크박스 한 줄, 독립 의미가 없는 짧은 목록 항목",
    "- 파일 안 예시 문자열·placeholder·명령 사용법을 실제 시스템 구성으로 오인한 후보",
    "",
    "### 별도 보존 후보",
    "",
    "- 폐기·대체된 결정은 삭제하지 않고 `supersedes` 방향과 유효 시점 근거를 가진 이력 노드로 보존",
    "- 확정할 수 없는 범주는 `ambiguous`로 남기고 자동 관계 저장에서 제외",
    "- source-local Section·Task는 원본 탐색용으로 유지하되 공용 overview 허브로 승격하지 않음",
    "",
    "## 읽기 전용 감사",
    "",
    `- 분석 전 fingerprint: \`${analysis.audit.before.documentDigest}\``,
    `- 분석 후 fingerprint: \`${analysis.audit.after.documentDigest}\``,
    `- 문서·블록·엔티티·관계·보강 작업 수량 보존: **${analysis.audit.readOnlyPreserved ? "PASS" : "FAIL"}**`,
    `- 853문서·전체 block coverage: **${analysis.audit.completeCoverage ? "PASS" : "FAIL"}**`,
    "",
    "## 한계",
    "",
    "- 이 단계의 범주와 용어는 정규식·빈도 기반 후보이며 관계 사실을 확정하지 않는다.",
    "- 과거 계획과 현재 구조의 시간 의미는 문서별 상세 검토 없이 자동 확정하지 않는다.",
    "- 같은 라벨의 의미 동일성은 아직 판정하지 않았으며 Phase 3 alias·동음이의어 검토가 필요하다.",
    "- Gold Graph 승인 전에는 전체 문서 의미 관계 재처리나 Codex 대량 보강을 실행하지 않는다.",
    "",
  ].join("\n");
}

export function analyzeCorpusDatabase(database) {
  database.exec("PRAGMA query_only = ON");
  const before = databaseFingerprint(database);
  const sourceDocuments = database.prepare(`
    SELECT id documentId, repository_id repositoryId, repository_name repositoryName,
      relative_path relativePath, commit_sha commitSha, hash, size,
      node_count nodeCount, edge_count edgeCount, parser_version parserVersion
    FROM documents WHERE source_type = 'github'
    ORDER BY repository_id, relative_path
  `).all();
  const linkCounts = new Map(database.prepare(`
    SELECT m.document_id documentId, COUNT(DISTINCT m.entity_id) linkCount
    FROM entity_mentions m JOIN documents d ON d.id = m.document_id
    WHERE d.source_type = 'github' AND m.entity_id LIKE 'reference:%'
    GROUP BY m.document_id
  `).all().map((row) => [row.documentId, Number(row.linkCount)]));
  const documents = [];
  const documentById = new Map();
  const repositoryRoles = new Map();
  for (const source of sourceDocuments) {
    const role = source.relativePath === "README.md" ? "README" : "dev-plan";
    const document = {
      ...source,
      role,
      linkCount: linkCounts.get(source.documentId) ?? 0,
      blocks: 0,
      characters: 0,
      blockTypes: {},
      classifications: Object.fromEntries(CONTENT_CATEGORIES.map((category) => [category, 0])),
    };
    documents.push(document);
    documentById.set(document.documentId, document);
    const roles = repositoryRoles.get(document.repositoryId) ?? new Set();
    roles.add(role);
    repositoryRoles.set(document.repositoryId, roles);
  }

  const blockTypes = new Map();
  const classifications = new Map(CONTENT_CATEGORIES.map((category) => [category, 0]));
  const categoryEvidence = new Map(CONTENT_CATEGORIES.map((category) => [category, []]));
  const headings = new Map();
  const candidates = {
    technologies: new Map(),
    components: new Map(),
    files: new Map(),
    apis: new Map(),
    dataSymbols: new Map(),
    phases: new Map(),
    testCommands: new Map(),
    statuses: new Map(),
    metrics: new Map(),
  };
  let totalBlocks = 0;
  let contentBlocks = 0;
  let characters = 0;
  for (const block of database.prepare(`
    SELECT b.id blockId, b.document_id documentId, b.type, b.depth, b.text, b.ordinal,
      b.source_url sourceUrl, d.hash documentHash,
      d.repository_id repositoryId, d.repository_name repositoryName
    FROM document_blocks b JOIN documents d ON d.id = b.document_id
    WHERE d.source_type = 'github'
    ORDER BY d.repository_id, d.relative_path, b.ordinal
  `).iterate()) {
    const document = documentById.get(block.documentId);
    if (!document) throw new Error(`분석 대상 문서가 없는 block입니다: ${block.blockId}`);
    totalBlocks += 1;
    characters += block.text.length;
    document.blocks += 1;
    document.characters += block.text.length;
    document.blockTypes[block.type] = (document.blockTypes[block.type] ?? 0) + 1;
    document.sourceUrl ??= block.sourceUrl;
    blockTypes.set(block.type, (blockTypes.get(block.type) ?? 0) + 1);
    const classification = classifyCorpusBlock(block);
    if (classification.primary !== "document-root") {
      contentBlocks += 1;
      classifications.set(classification.primary, classifications.get(classification.primary) + 1);
      document.classifications[classification.primary] += 1;
      const evidence = categoryEvidence.get(classification.primary);
      if (evidence.length < 5 && block.sourceUrl) {
        evidence.push({
          repositoryName: block.repositoryName,
          text: sanitizeEvidence(block.text),
          sourceUrl: block.sourceUrl,
        });
      }
    }
    if (block.type === "heading") {
      const normalized = normalizeHeading(block.text);
      if (normalized) {
        const heading = headings.get(normalized) ?? {
          label: sanitizeEvidence(block.text),
          occurrences: 0,
          documents: new Set(),
          repositories: new Set(),
        };
        heading.occurrences += 1;
        heading.documents.add(block.documentId);
        heading.repositories.add(block.repositoryId);
        headings.set(normalized, heading);
      }
    }
    extractBlockCandidates(block, candidates);
  }

  const graph = analyzeGraph(database);
  const sharedEntities = database.prepare(`
    SELECT e.id, e.label, e.kind, COUNT(*) mentions,
      COUNT(DISTINCT m.document_id) documents,
      COUNT(DISTINCT d.repository_id) repositories
    FROM entity_mentions m JOIN entities e ON e.id = m.entity_id
      JOIN documents d ON d.id = m.document_id
    WHERE d.source_type = 'github'
    GROUP BY e.id, e.label, e.kind HAVING COUNT(DISTINCT m.document_id) > 1
    ORDER BY repositories DESC, documents DESC, mentions DESC, e.label
    LIMIT 100
  `).all();
  const duplicateLabels = database.prepare(`
    SELECT lower(trim(label)) normalizedLabel, MIN(label) exampleLabel,
      COUNT(*) entities
    FROM entities GROUP BY lower(trim(label)) HAVING COUNT(*) > 1
    ORDER BY entities DESC, normalizedLabel LIMIT 100
  `).all();
  const sharedEntityTotals = database.prepare(`
    SELECT COUNT(*) sharedEntities,
      COALESCE(SUM(CASE WHEN repositories > 1 THEN 1 ELSE 0 END), 0) crossRepositoryEntities
    FROM (
      SELECT m.entity_id, COUNT(DISTINCT m.document_id) documents,
        COUNT(DISTINCT d.repository_id) repositories
      FROM entity_mentions m JOIN documents d ON d.id = m.document_id
      WHERE d.source_type = 'github'
      GROUP BY m.entity_id HAVING COUNT(DISTINCT m.document_id) > 1
    )
  `).get();
  const duplicateLabelGroupCount = database.prepare(`
    SELECT COUNT(*) groupsCount FROM (
      SELECT lower(trim(label)) normalizedLabel
      FROM entities GROUP BY lower(trim(label)) HAVING COUNT(*) > 1
    )
  `).get().groupsCount;
  const repeatedHeadings = [...headings.entries()]
    .map(([normalized, heading]) => ({
      normalized,
      label: heading.label,
      occurrences: heading.occurrences,
      documents: heading.documents.size,
      repositories: heading.repositories.size,
      boilerplateCandidate: BOILERPLATE_HEADINGS.has(normalized)
        || (heading.repositories.size >= 10 && heading.documents.size >= 20),
    }))
    .filter((heading) => heading.documents >= 2)
    .sort((left, right) =>
      right.repositories - left.repositories
      || right.documents - left.documents
      || right.occurrences - left.occurrences
      || left.normalized.localeCompare(right.normalized));
  const snapshotDocuments = documents.map((document) => ({
    ...document,
    classifications: Object.fromEntries(Object.entries(document.classifications).filter(([, count]) => count > 0)),
  }));
  const snapshotDigest = sha256(JSON.stringify(snapshotDocuments.map((document) => ({
    id: document.documentId,
    hash: document.hash,
    commitSha: document.commitSha,
    blocks: document.blocks,
    characters: document.characters,
  }))));
  const documentsByHash = new Map();
  for (const document of documents) {
    const group = documentsByHash.get(document.hash) ?? [];
    group.push(document);
    documentsByHash.set(document.hash, group);
  }
  const duplicateGroups = [...documentsByHash.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({
      hash,
      documents: group.length,
      repositories: new Set(group.map((document) => document.repositoryId)).size,
      examples: group.slice(0, 4).map((document) => ({
        repositoryName: document.repositoryName,
        relativePath: document.relativePath,
      })),
    }))
    .sort((left, right) => right.repositories - left.repositories || right.documents - left.documents || left.hash.localeCompare(right.hash));
  const after = databaseFingerprint(database);
  const completeCoverage = documents.length === Number(before.documents)
    && totalBlocks === Number(before.blocks)
    && documents.every((document) => document.blocks > 0);
  const readOnlyPreserved = JSON.stringify(before) === JSON.stringify(after);
  const analysis = {
    version: 1,
    generatedAt: new Date().toISOString(),
    snapshotDigest,
    corpus: {
      repositories: new Set(documents.map((document) => document.repositoryId)).size,
      documents: documents.length,
      readme: documents.filter((document) => document.role === "README").length,
      devPlan: documents.filter((document) => document.role === "dev-plan").length,
      bytes: documents.reduce((sum, document) => sum + document.size, 0),
      parserVersions: Object.fromEntries(documents.reduce((map, document) =>
        map.set(document.parserVersion, (map.get(document.parserVersion) ?? 0) + 1), new Map())),
    },
    blocks: {
      total: totalBlocks,
      contentBlocks,
      characters,
      linkReferences: documents.reduce((sum, document) => sum + document.linkCount, 0),
      types: Object.fromEntries([...blockTypes.entries()].sort((left, right) => right[1] - left[1])),
      classifications: Object.fromEntries(classifications),
      evidence: Object.fromEntries(categoryEvidence),
    },
    graph,
    duplicateContent: {
      uniqueHashes: documentsByHash.size,
      groupCount: duplicateGroups.length,
      documentsInGroups: duplicateGroups.reduce((sum, group) => sum + group.documents, 0),
      groups: duplicateGroups.slice(0, 100),
    },
    repeatedHeadings: repeatedHeadings.slice(0, 100),
    candidates: {
      technologies: serializeCandidates(candidates.technologies),
      components: serializeCandidates(candidates.components),
      files: serializeCandidates(candidates.files),
      apis: serializeCandidates(candidates.apis),
      dataSymbols: serializeCandidates(candidates.dataSymbols),
      phases: serializeCandidates(candidates.phases),
      testCommands: serializeCandidates(candidates.testCommands),
      statuses: serializeCandidates(candidates.statuses),
      metrics: serializeCandidates(candidates.metrics),
      sharedEntities,
      duplicateLabels,
    },
    crossDocument: {
      repositoriesWithBothRoles: [...repositoryRoles.values()].filter((roles) => roles.size > 1).length,
      sharedEntities: Number(sharedEntityTotals.sharedEntities),
      crossRepositoryEntities: Number(sharedEntityTotals.crossRepositoryEntities),
      duplicateLabelGroups: Number(duplicateLabelGroupCount),
      pairs: buildCrossDocumentPairs(documents, candidates),
    },
    goldGraphCandidates: selectGoldCandidates(documents, repositoryRoles),
    audit: { before, after, readOnlyPreserved, completeCoverage },
  };
  const snapshot = {
    version: 1,
    generatedAt: analysis.generatedAt,
    databaseFingerprint: before,
    snapshotDigest,
    documents: snapshotDocuments,
  };
  return { snapshot, analysis };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const databasePath = await resolveLocalD1Database({ requested: options.database });
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const { snapshot, analysis } = analyzeCorpusDatabase(database);
    await atomicWrite(options.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
    await atomicWrite(options.outputJson, `${JSON.stringify(analysis, null, 2)}\n`);
    await atomicWrite(options.outputMarkdown, `${renderMarkdown(analysis)}\n`);
    console.info(`[corpus-analysis] documents=${analysis.corpus.documents} blocks=${analysis.blocks.total}`);
    console.info(`[corpus-analysis] entities=${analysis.graph.entities} relations=${analysis.graph.relations}`);
    console.info(`[corpus-analysis] read_only=${analysis.audit.readOnlyPreserved} coverage=${analysis.audit.completeCoverage}`);
    if (!analysis.audit.readOnlyPreserved || !analysis.audit.completeCoverage) process.exitCode = 1;
  } finally {
    database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`[corpus-analysis] ${error instanceof Error ? error.stack ?? error.message : "알 수 없는 오류"}`);
    process.exitCode = 1;
  });
}
