import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveLocalD1Database } from "./lib/local-d1.mjs";

function parseArguments(argv) {
  const options = {
    receipt: "docs/github-full-reindex-20260805.json",
    database: "",
    outputJson: "docs/github-full-reindex-audit-20260806.json",
    outputMarkdown: "docs/github-full-reindex-audit-20260806.md",
    compareGraphReceipt: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--receipt" && next) options.receipt = next;
    else if (value === "--database" && next) options.database = next;
    else if (value === "--output-json" && next) options.outputJson = next;
    else if (value === "--output-md" && next) options.outputMarkdown = next;
    else if (value === "--source-only") {
      options.compareGraphReceipt = false;
      continue;
    }
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

function query(database, sql) {
  const output = execFileSync("sqlite3", ["-json", resolve(database), sql], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function numberValue(value) {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`잘못된 D1 집계 값입니다: ${value}`);
  return result;
}

function renderMarkdown(audit) {
  const format = new Intl.NumberFormat("ko-KR");
  const parserRows = audit.parserVersions.map((row) =>
    `| ${row.parserVersion} | ${format.format(row.documents)} |`).join("\n");
  return [
    "# GitHub Markdown 전체 수집 D1 감사 영수증",
    "",
    `생성 시각: \`${audit.generatedAt}\``,
    "",
    `판정: **${audit.passed ? "PASS" : "FAIL"}**`,
    "",
    "## 정본 집계",
    "",
    "| 항목 | 수량 |",
    "|---|---:|",
    `| 수집 대상 저장소 | ${format.format(audit.collection.repositories)} |`,
    `| 문서가 저장된 저장소 | ${format.format(audit.database.repositories)} |`,
    `| 빈 저장소 | ${format.format(audit.collection.empty)} |`,
    `| GitHub Markdown | ${format.format(audit.database.documents)} |`,
    `| 원문 bytes | ${format.format(audit.database.bytes)} |`,
    `| 문서 노드 합계 | ${format.format(audit.database.nodes)} |`,
    `| 문서 관계 합계 | ${format.format(audit.database.edges)} |`,
    `| 최초 Apply 그래프 수량 비교 | ${audit.graphReceiptCompared ? "실행" : "생략 — 후속 parser 재처리됨"} |`,
    "",
    "## 파서 버전",
    "",
    "| 버전 | 문서 |",
    "|---|---:|",
    parserRows,
    "",
    "## 무결성",
    "",
    "| 검사 | 결과 |",
    "|---|---:|",
    `| 저장소별 영수증 불일치 | ${format.format(audit.integrity.repositoryReceiptMismatches)} |`,
    `| 중복 source_key | ${format.format(audit.integrity.duplicateSourceKeys)} |`,
    `| 문서 없는 block | ${format.format(audit.integrity.blocksWithoutDocument)} |`,
    `| 문서 없는 mention | ${format.format(audit.integrity.mentionsWithoutDocument)} |`,
    `| entity 없는 mention | ${format.format(audit.integrity.mentionsWithoutEntity)} |`,
    `| 문서 없는 relation | ${format.format(audit.integrity.relationsWithoutDocument)} |`,
    `| source entity 없는 relation | ${format.format(audit.integrity.relationSourcesWithoutEntity)} |`,
    `| target entity 없는 relation | ${format.format(audit.integrity.relationTargetsWithoutEntity)} |`,
    `| 잔여 staging row | ${format.format(audit.integrity.stagingRows)} |`,
    "",
    ...(audit.issues.length ? ["## 이슈", "", ...audit.issues.map((issue) => `- ${issue}`), ""] : []),
  ].join("\n");
}

export function auditCollection(receipt, rows, options = {}) {
  const compareGraphReceipt = options.compareGraphReceipt !== false;
  const completed = receipt.repositories.filter((repository) => repository.status === "completed");
  const empty = receipt.repositories.filter((repository) => repository.status === "empty");
  const repositoryRows = new Map(rows.repositories.map((row) => [String(row.repositoryId), row]));
  const issues = [];

  for (const repository of completed) {
    const stored = repositoryRows.get(String(repository.repositoryId));
    const expected = repository.receipt;
    if (!stored) {
      issues.push(`${repository.repositoryName}: D1 문서가 없습니다.`);
      continue;
    }
    const comparisons = [
      ["문서", expected.fileCount, stored.documents],
      ["bytes", repository.actualBytes, stored.bytes],
    ];
    if (compareGraphReceipt) {
      comparisons.push(
        ["노드", expected.nodeCount, stored.nodes],
        ["관계", expected.edgeCount, stored.edges],
      );
    }
    for (const [label, expectedValue, actualValue] of comparisons) {
      if (numberValue(expectedValue) !== numberValue(actualValue)) {
        issues.push(`${repository.repositoryName}: ${label} 영수증=${expectedValue}, D1=${actualValue}`);
      }
    }
    if (Number(stored.commitCount) !== 1 || stored.commitSha !== expected.commitSha) {
      issues.push(`${repository.repositoryName}: commit SHA가 영수증과 다릅니다.`);
    }
  }
  for (const repository of empty) {
    if (repositoryRows.has(String(repository.repositoryId))) {
      issues.push(`${repository.repositoryName}: 빈 저장소에 D1 문서가 남아 있습니다.`);
    }
  }

  const database = {
    documents: numberValue(rows.total.documents),
    repositories: numberValue(rows.total.repositories),
    bytes: numberValue(rows.total.bytes),
    nodes: numberValue(rows.total.nodes),
    edges: numberValue(rows.total.edges),
  };
  const collection = {
    repositories: numberValue(receipt.totals.repositories),
    completed: numberValue(receipt.totals.completed),
    empty: numberValue(receipt.totals.empty),
    blocked: numberValue(receipt.totals.blocked),
    failed: numberValue(receipt.totals.failed),
    pending: numberValue(receipt.totals.pending),
    documents: numberValue(receipt.totals.documents),
  };
  for (const [label, expected, actual] of [
    ["문서", collection.documents, database.documents],
    ["저장 저장소", collection.completed, database.repositories],
  ]) {
    if (expected !== actual) issues.push(`전체 ${label} 합계가 영수증(${expected})과 D1(${actual})에서 다릅니다.`);
  }
  if (collection.completed + collection.empty + collection.blocked + collection.failed + collection.pending !== collection.repositories) {
    issues.push("저장소 최종 상태 합계가 전체 저장소 수와 다릅니다.");
  }
  if (collection.blocked || collection.failed || collection.pending) {
    issues.push(`미완료 저장소가 있습니다: blocked=${collection.blocked}, failed=${collection.failed}, pending=${collection.pending}`);
  }

  const integrity = Object.fromEntries(Object.entries(rows.integrity).map(([key, value]) => [key, numberValue(value)]));
  integrity.repositoryReceiptMismatches = issues.filter((issue) => issue.includes(":")).length;
  for (const [key, value] of Object.entries(integrity)) {
    if (key !== "repositoryReceiptMismatches" && value !== 0) issues.push(`${key}=${value}`);
  }
  return {
    generatedAt: new Date().toISOString(),
    passed: issues.length === 0,
    graphReceiptCompared: compareGraphReceipt,
    collection,
    database,
    parserVersions: rows.parserVersions.map((row) => ({
      parserVersion: String(row.parserVersion),
      documents: numberValue(row.documents),
    })),
    integrity,
    issues,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const receipt = JSON.parse(await readFile(resolve(options.receipt), "utf8"));
  const database = await resolveLocalD1Database({ requested: options.database });
  const [total] = query(database, `
    SELECT COUNT(*) documents, COUNT(DISTINCT repository_id) repositories,
      COALESCE(SUM(size), 0) bytes, COALESCE(SUM(node_count), 0) nodes,
      COALESCE(SUM(edge_count), 0) edges
    FROM documents WHERE source_type = 'github'
  `);
  const repositories = query(database, `
    SELECT repository_id repositoryId, COUNT(*) documents, COALESCE(SUM(size), 0) bytes,
      COALESCE(SUM(node_count), 0) nodes, COALESCE(SUM(edge_count), 0) edges,
      COUNT(DISTINCT commit_sha) commitCount, MIN(commit_sha) commitSha
    FROM documents WHERE source_type = 'github' GROUP BY repository_id
  `);
  const parserVersions = query(database, `
    SELECT parser_version parserVersion, COUNT(*) documents
    FROM documents WHERE source_type = 'github' GROUP BY parser_version ORDER BY parser_version
  `);
  const [integrity] = query(database, `
    SELECT
      (SELECT COUNT(*) FROM (SELECT source_key FROM documents GROUP BY source_key HAVING COUNT(*) > 1)) duplicateSourceKeys,
      (SELECT COUNT(*) FROM document_blocks b LEFT JOIN documents d ON d.id = b.document_id WHERE d.id IS NULL) blocksWithoutDocument,
      (SELECT COUNT(*) FROM entity_mentions m LEFT JOIN documents d ON d.id = m.document_id WHERE d.id IS NULL) mentionsWithoutDocument,
      (SELECT COUNT(*) FROM entity_mentions m LEFT JOIN entities e ON e.id = m.entity_id WHERE e.id IS NULL) mentionsWithoutEntity,
      (SELECT COUNT(*) FROM relations r LEFT JOIN documents d ON d.id = r.document_id WHERE d.id IS NULL) relationsWithoutDocument,
      (SELECT COUNT(*) FROM relations r LEFT JOIN entities e ON e.id = r.source_id WHERE e.id IS NULL) relationSourcesWithoutEntity,
      (SELECT COUNT(*) FROM relations r LEFT JOIN entities e ON e.id = r.target_id WHERE e.id IS NULL) relationTargetsWithoutEntity,
      (SELECT COUNT(*) FROM staged_documents)
        + (SELECT COUNT(*) FROM staged_document_blocks)
        + (SELECT COUNT(*) FROM staged_entities)
        + (SELECT COUNT(*) FROM staged_entity_mentions)
        + (SELECT COUNT(*) FROM staged_relations)
        + (SELECT COUNT(*) FROM staged_ingestion_jobs)
        + (SELECT COUNT(*) FROM staged_github_document_targets)
        + (SELECT COUNT(*) FROM github_apply_stage_chunks) stagingRows
  `);
  const audit = auditCollection(receipt, { total, repositories, parserVersions, integrity }, {
    compareGraphReceipt: options.compareGraphReceipt,
  });
  await atomicWrite(options.outputJson, `${JSON.stringify(audit, null, 2)}\n`);
  await atomicWrite(options.outputMarkdown, `${renderMarkdown(audit)}\n`);
  console.info(`[full-collection-audit] ${audit.passed ? "PASS" : "FAIL"} issues=${audit.issues.length}`);
  console.info(`[full-collection-audit] documents=${audit.database.documents} repositories=${audit.database.repositories}`);
  if (!audit.passed) process.exitCode = 1;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`[full-collection-audit] ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    process.exitCode = 1;
  });
}
