import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationPromise = readFile(
  new URL("../drizzle/0006_markdown_profile_evidence.sql", import.meta.url),
  "utf8",
);

function databaseBeforeProfileEvidence() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE document_blocks (id TEXT PRIMARY KEY, document_id TEXT, type TEXT, depth INTEGER, text TEXT, ordinal INTEGER);
    CREATE TABLE entity_mentions (id TEXT PRIMARY KEY, document_id TEXT, entity_id TEXT, block_id TEXT, origin TEXT);
    CREATE TABLE staged_document_blocks (stage_id TEXT, id TEXT, document_id TEXT, type TEXT, depth INTEGER, text TEXT, ordinal INTEGER);
    CREATE TABLE staged_entity_mentions (stage_id TEXT, id TEXT, document_id TEXT, entity_id TEXT, block_id TEXT, origin TEXT);
    INSERT INTO document_blocks VALUES ('block-1', 'document-1', 'heading', 1, '기존 근거', 0);
    INSERT INTO entity_mentions VALUES ('mention-1', 'document-1', 'entity-1', 'block-1', 'rule');
  `);
  return database;
}

test("0006은 기존 block·mention을 보존하며 GitHub source URL evidence 열을 추가한다", async () => {
  const database = databaseBeforeProfileEvidence();
  try {
    database.exec(await migrationPromise);
    for (const table of [
      "document_blocks",
      "entity_mentions",
      "staged_document_blocks",
      "staged_entity_mentions",
    ]) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
      assert.ok(columns.includes("source_url"), `${table} source_url column missing`);
    }
    assert.equal(
      database.prepare("SELECT text FROM document_blocks WHERE id = 'block-1'").get().text,
      "기존 근거",
    );
    assert.equal(
      database.prepare("SELECT entity_id FROM entity_mentions WHERE id = 'mention-1'").get().entity_id,
      "entity-1",
    );
  } finally {
    database.close();
  }
});

test("0006은 후속 실패 시 transaction rollback으로 원래 schema를 복원한다", async () => {
  const database = databaseBeforeProfileEvidence();
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(await migrationPromise);
      database.exec("ALTER TABLE missing_table ADD COLUMN impossible TEXT");
      database.exec("COMMIT");
      assert.fail("fault injection should fail");
    } catch {
      database.exec("ROLLBACK");
    }
    const columns = database.prepare("PRAGMA table_info(document_blocks)").all().map((row) => row.name);
    assert.equal(columns.includes("source_url"), false);
  } finally {
    database.close();
  }
});
