import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  auditLocalD1Database,
  createLocalD1Backup,
  verifyBackupCopy,
} from "../scripts/lib/local-d1-baseline.mjs";

const createFixture = (path) => {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY, source_type TEXT, parser_version TEXT);
    CREATE TABLE document_blocks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL);
    CREATE TABLE entities (id TEXT PRIMARY KEY);
    CREATE TABLE entity_mentions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, entity_id TEXT NOT NULL);
    CREATE TABLE relations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL, origin TEXT NOT NULL);
    CREATE TABLE ingestion_jobs (id TEXT PRIMARY KEY);
    CREATE TABLE enrichment_jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE staged_documents (id TEXT PRIMARY KEY);
    CREATE TABLE staged_document_blocks (id TEXT PRIMARY KEY);
    CREATE TABLE staged_entities (id TEXT PRIMARY KEY);
    CREATE TABLE staged_entity_mentions (id TEXT PRIMARY KEY);
    CREATE TABLE staged_relations (id TEXT PRIMARY KEY);
    CREATE TABLE staged_github_document_targets (id TEXT PRIMARY KEY);
    INSERT INTO documents VALUES ('document-1', 'manual', 'remark-ast-1');
    INSERT INTO document_blocks VALUES ('block-1', 'document-1');
    INSERT INTO entities VALUES ('entity-1'), ('entity-2');
    INSERT INTO entity_mentions VALUES ('mention-1', 'document-1', 'entity-1'), ('mention-2', 'document-1', 'entity-2');
    INSERT INTO relations VALUES ('relation-1', 'document-1', 'entity-1', 'entity-2', 'contains', 'rule');
    INSERT INTO ingestion_jobs VALUES ('ingestion-1');
    INSERT INTO enrichment_jobs VALUES ('enrichment-1', 'queued');
  `);
  database.close();
};

test("로컬 D1 기준선 감사는 수량·orphan·결정적 fingerprint를 반환한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-d1-baseline-"));
  try {
    const databasePath = join(root, "fixture.sqlite");
    createFixture(databasePath);
    const first = auditLocalD1Database(databasePath);
    const second = auditLocalD1Database(databasePath);
    assert.deepEqual(first.counts, {
      documents: 1,
      blocks: 1,
      entities: 2,
      mentions: 2,
      relations: 1,
      ingestionJobs: 1,
      enrichmentJobs: 1,
    });
    assert.equal(first.integrityCheck, "ok");
    assert.equal(Object.values(first.integrity).reduce((sum, value) => sum + value, 0), 0);
    assert.equal(first.dataFingerprint, second.dataFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("로컬 D1 backup은 fingerprint·SHA-256 영수증과 임시 복구 검증을 제공한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-d1-backup-"));
  try {
    const databasePath = join(root, "fixture.sqlite");
    const backupDirectory = join(root, "backups");
    const reportDirectory = join(root, "reports");
    await mkdir(backupDirectory, { recursive: true });
    createFixture(databasePath);
    const receipt = await createLocalD1Backup({
      databasePath,
      backupDirectory,
      reportDirectory,
      stamp: "fixture",
    });
    assert.equal(receipt.verification.fingerprintMatches, true);
    assert.equal(receipt.verification.integrityOk, true);
    assert.equal(receipt.verification.orphanCount, 0);
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    const storedReceipt = JSON.parse(await readFile(receipt.receiptPath, "utf8"));
    assert.equal(storedReceipt.dataFingerprint, receipt.dataFingerprint);
    const restored = await verifyBackupCopy(receipt.backupPath);
    assert.equal(restored.audit.integrityCheck, "ok");
    assert.equal(restored.audit.dataFingerprint, receipt.dataFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
