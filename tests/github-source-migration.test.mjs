import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const legacyDocumentsSql = `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    status TEXT NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0,
    edge_count INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE document_blocks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    type TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    ordinal INTEGER NOT NULL
  );
`;

function legacyDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(legacyDocumentsSql);
  database.prepare(`INSERT INTO documents (
    id, file_name, normalized_name, source, size, hash, status,
    node_count, edge_count, parser_version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      "document-legacy",
      "README.md",
      "readme.md",
      "# 기존 문서",
      12,
      "legacy-hash",
      "completed",
      1,
      0,
      "markdown-ast-v1",
      "2026-08-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );
  database.prepare(
    "INSERT INTO document_blocks (id, document_id, type, depth, text, ordinal) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("block-legacy", "document-legacy", "heading", 1, "기존 문서", 0);
  return database;
}

const migrationPromise = readFile(
  new URL("../drizzle/0004_github_sources.sql", import.meta.url),
  "utf8",
);

function applyMigration(database, migration) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(migration);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertGitHubDocument(database, { id, repositoryId, path, sourceKey }) {
  database.prepare(`INSERT INTO documents (
    id, file_name, normalized_name, source, source_type, source_key,
    repository_id, repository_owner, repository_name, relative_path, source_ref,
    commit_sha, blob_sha, source_url, size, hash, status, node_count, edge_count,
    parser_version, created_at, updated_at
  ) VALUES (?, ?, ?, ?, 'github', ?, ?, 'coreline-ai', ?, ?, 'main', ?, ?, ?, ?, ?, 'completed', 1, 0, 'markdown-ast-v1', ?, ?)`)
    .run(
      id,
      path.split("/").at(-1),
      "readme.md",
      `# ${repositoryId}`,
      sourceKey,
      repositoryId,
      `repo-${repositoryId}`,
      path,
      "a".repeat(40),
      "b".repeat(40),
      `https://github.com/coreline-ai/repo-${repositoryId}/blob/${"a".repeat(40)}/${path}`,
      20,
      `hash-${repositoryId}`,
      "2026-08-04T00:00:00.000Z",
      "2026-08-04T00:00:00.000Z",
    );
}

test("0004 backfills manual sources and permits same-named GitHub documents", async () => {
  const database = legacyDatabase();
  try {
    applyMigration(database, await migrationPromise);

    const legacy = database.prepare(
      "SELECT id, source_type, source_key, source FROM documents WHERE id = ?",
    ).get("document-legacy");
    assert.deepEqual({ ...legacy }, {
      id: "document-legacy",
      source_type: "manual",
      source_key: "manual:readme.md",
      source: "# 기존 문서",
    });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM document_blocks WHERE document_id = ?")
        .get("document-legacy").count,
      1,
    );

    insertGitHubDocument(database, {
      id: "document-github-1",
      repositoryId: "1001",
      path: "README.md",
      sourceKey: "github:1001:README.md",
    });
    insertGitHubDocument(database, {
      id: "document-github-2",
      repositoryId: "1002",
      path: "README.md",
      sourceKey: "github:1002:README.md",
    });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM documents WHERE normalized_name = 'readme.md'")
        .get().count,
      3,
    );
    assert.throws(
      () => insertGitHubDocument(database, {
        id: "document-github-duplicate",
        repositoryId: "1001",
        path: "README.md",
        sourceKey: "github:1001:README.md",
      }),
      /UNIQUE constraint failed: documents.source_key/,
    );

    database.prepare(`INSERT INTO github_repositories (
      repository_id, owner, name, visibility, is_private, default_branch,
      sync_enabled, status, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("1001", "coreline-ai", "repo-1001", "private", 1, "main", 1, "selected", "2026-08-04T00:00:00.000Z");
    database.prepare(`INSERT INTO github_sync_runs (
      id, kind, status, discovered_count, selected_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("sync-1", "discovery", "completed", 117, 1, "2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
    assert.equal(database.prepare("SELECT sync_enabled FROM github_repositories WHERE repository_id = '1001'").get().sync_enabled, 1);
    assert.equal(database.prepare("SELECT discovered_count FROM github_sync_runs WHERE id = 'sync-1'").get().discovered_count, 117);
  } finally {
    database.close();
  }
});

test("0004 remains rollback-safe when a later statement fails", async () => {
  const database = legacyDatabase();
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(await migrationPromise);
      database.prepare("INSERT INTO documents (id, source_key) VALUES (?, ?)")
        .run("forced-failure", "manual:forced-failure.md");
      database.exec("COMMIT");
      assert.fail("fault injection should fail the migration transaction");
    } catch {
      database.exec("ROLLBACK");
    }

    const columns = database.prepare("PRAGMA table_info(documents)").all().map((row) => row.name);
    assert.ok(!columns.includes("source_key"));
    assert.equal(
      database.prepare("SELECT source FROM documents WHERE id = ?").get("document-legacy").source,
      "# 기존 문서",
    );
    assert.equal(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_repositories'").get(),
      undefined,
    );
  } finally {
    database.close();
  }
});
