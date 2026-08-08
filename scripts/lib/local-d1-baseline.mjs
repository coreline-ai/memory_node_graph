import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const REQUIRED_GRAPH_TABLES = Object.freeze([
  "documents",
  "document_blocks",
  "entities",
  "entity_mentions",
  "relations",
  "ingestion_jobs",
  "enrichment_jobs",
]);

const STAGING_TABLES = Object.freeze([
  "staged_documents",
  "staged_document_blocks",
  "staged_entities",
  "staged_entity_mentions",
  "staged_relations",
  "staged_github_document_targets",
]);

const scalar = (database, sql) => Number(database.prepare(sql).get()?.value ?? 0);
const grouped = (database, sql) => database.prepare(sql).all().map((row) => ({
  value: String(row.value ?? "unknown"),
  count: Number(row.count ?? 0),
}));

const stableObject = (value) => {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableObject(item)]));
};

const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

export async function sha256File(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

const fingerprintFor = (summary) => sha256Text(JSON.stringify(stableObject({
  counts: summary.counts,
  documentsBySource: summary.documentsBySource,
  parserVersions: summary.parserVersions,
  relationOrigins: summary.relationOrigins,
  relationTypes: summary.relationTypes,
  enrichmentStatuses: summary.enrichmentStatuses,
  integrity: summary.integrity,
})));

export function auditLocalD1Database(databasePath) {
  const resolvedPath = resolve(databasePath);
  const database = new DatabaseSync(resolvedPath);
  try {
    database.exec("PRAGMA query_only = ON");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String(row.name));
    const missingTables = REQUIRED_GRAPH_TABLES.filter((table) => !tables.includes(table));
    if (missingTables.length) {
      throw new Error(`필수 D1 테이블이 없습니다: ${missingTables.join(", ")}`);
    }
    const count = (table) => scalar(database, `SELECT COUNT(*) AS value FROM ${table}`);
    const staging = Object.fromEntries(STAGING_TABLES
      .filter((table) => tables.includes(table))
      .map((table) => [table, count(table)]));
    const summary = {
      databasePath: resolvedPath,
      integrityCheck: String(database.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "unknown"),
      counts: {
        documents: count("documents"),
        blocks: count("document_blocks"),
        entities: count("entities"),
        mentions: count("entity_mentions"),
        relations: count("relations"),
        ingestionJobs: count("ingestion_jobs"),
        enrichmentJobs: count("enrichment_jobs"),
      },
      documentsBySource: grouped(database,
        "SELECT COALESCE(source_type, 'unknown') AS value, COUNT(*) AS count FROM documents GROUP BY source_type ORDER BY value"),
      parserVersions: grouped(database,
        "SELECT parser_version AS value, COUNT(*) AS count FROM documents GROUP BY parser_version ORDER BY value"),
      relationOrigins: grouped(database,
        "SELECT origin AS value, COUNT(*) AS count FROM relations GROUP BY origin ORDER BY value"),
      relationTypes: grouped(database,
        "SELECT type AS value, COUNT(*) AS count FROM relations GROUP BY type ORDER BY count DESC, value"),
      enrichmentStatuses: grouped(database,
        "SELECT status AS value, COUNT(*) AS count FROM enrichment_jobs GROUP BY status ORDER BY value"),
      staging,
      integrity: {
        blocksWithoutDocument: scalar(database,
          "SELECT COUNT(*) AS value FROM document_blocks b LEFT JOIN documents d ON d.id = b.document_id WHERE d.id IS NULL"),
        mentionsWithoutDocument: scalar(database,
          "SELECT COUNT(*) AS value FROM entity_mentions m LEFT JOIN documents d ON d.id = m.document_id WHERE d.id IS NULL"),
        mentionsWithoutEntity: scalar(database,
          "SELECT COUNT(*) AS value FROM entity_mentions m LEFT JOIN entities e ON e.id = m.entity_id WHERE e.id IS NULL"),
        relationsWithoutDocument: scalar(database,
          "SELECT COUNT(*) AS value FROM relations r LEFT JOIN documents d ON d.id = r.document_id WHERE d.id IS NULL"),
        relationsWithoutSource: scalar(database,
          "SELECT COUNT(*) AS value FROM relations r LEFT JOIN entities e ON e.id = r.source_id WHERE e.id IS NULL"),
        relationsWithoutTarget: scalar(database,
          "SELECT COUNT(*) AS value FROM relations r LEFT JOIN entities e ON e.id = r.target_id WHERE e.id IS NULL"),
        duplicateRelations: scalar(database, `SELECT COUNT(*) AS value FROM (
          SELECT document_id, source_id, target_id, type, COUNT(*) AS count
          FROM relations GROUP BY document_id, source_id, target_id, type HAVING COUNT(*) > 1
        )`),
      },
    };
    return { ...summary, dataFingerprint: fingerprintFor(summary) };
  } finally {
    database.close();
  }
}

const sqliteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const timestamp = () => new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");

export async function verifyBackupCopy(backupPath) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-d1-restore-check-"));
  const restoredPath = join(directory, basename(backupPath));
  try {
    await copyFile(backupPath, restoredPath);
    const audit = auditLocalD1Database(restoredPath);
    return { audit };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createLocalD1Backup(input) {
  const databasePath = resolve(input.databasePath);
  const stamp = input.stamp ?? timestamp();
  const backupDirectory = resolve(input.backupDirectory ?? join(dirname(databasePath), "backups"));
  const reportDirectory = resolve(input.reportDirectory ?? join(dirname(dirname(dirname(dirname(dirname(databasePath))))), "reports"));
  await mkdir(backupDirectory, { recursive: true });
  await mkdir(reportDirectory, { recursive: true });
  const backupPath = join(backupDirectory, `${basename(databasePath, ".sqlite")}.${stamp}.sqlite`);
  const sourceAudit = auditLocalD1Database(databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA wal_checkpoint(FULL)");
    database.exec(`VACUUM INTO ${sqliteLiteral(backupPath)}`);
  } finally {
    database.close();
  }
  const backupAudit = auditLocalD1Database(backupPath);
  const verification = {
    fingerprintMatches: sourceAudit.dataFingerprint === backupAudit.dataFingerprint,
    integrityOk: backupAudit.integrityCheck === "ok",
    orphanCount: Object.entries(backupAudit.integrity)
      .filter(([key]) => key !== "duplicateRelations")
      .reduce((sum, [, value]) => sum + Number(value), 0),
    duplicateRelationGroups: backupAudit.integrity.duplicateRelations,
    stagingRowCount: Object.values(backupAudit.staging).reduce((sum, value) => sum + Number(value), 0),
  };
  if (!verification.fingerprintMatches || !verification.integrityOk) {
    throw new Error(`D1 backup 검증에 실패했습니다: ${JSON.stringify(verification)}`);
  }
  const fileStat = await stat(backupPath);
  const receipt = {
    generatedAt: new Date().toISOString(),
    sourcePath: databasePath,
    backupPath,
    bytes: fileStat.size,
    sha256: await sha256File(backupPath),
    dataFingerprint: backupAudit.dataFingerprint,
    verification,
    sourceAudit,
    backupAudit,
  };
  const receiptPath = join(reportDirectory, `d1-baseline-${stamp}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { ...receipt, receiptPath };
}
