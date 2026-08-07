import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const legacySchema = `
  CREATE TABLE github_sync_runs (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
    selection_digest TEXT, manifest_digest TEXT,
    discovered_count INTEGER NOT NULL DEFAULT 0,
    selected_count INTEGER NOT NULL DEFAULT 0,
    changed_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    error_code TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, completed_at TEXT
  );
  CREATE TABLE github_source_jobs (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL,
    input_json TEXT NOT NULL, result_json TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    manual_retry_count INTEGER NOT NULL DEFAULT 0,
    last_manual_retry_at TEXT, lease_owner TEXT, lease_expires_at TEXT,
    error_code TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    started_at TEXT, completed_at TEXT
  );
`;

const migrationPromise = readFile(
  new URL("../drizzle/0007_github_apply_recovery.sql", import.meta.url),
  "utf8",
);
const stageMigrationPromise = readFile(
  new URL("../drizzle/0008_github_apply_stage_chunks.sql", import.meta.url),
  "utf8",
);
const atomicRepositoryStageMigrationPromise = readFile(
  new URL("../drizzle/0009_github_repository_atomic_stage.sql", import.meta.url),
  "utf8",
);

const applyInput = (nonce) => JSON.stringify({
  jobId: `apply-${nonce}`,
  idempotencyKey: `key-${nonce}`,
  kind: "apply",
  owner: "coreline-ai",
  selectedRepositoryIds: ["1001"],
  manifestDigest: "a".repeat(64),
  requestNonce: nonce,
});

test("0008은 재시도 가능한 문서 경계 Apply stage 저장소를 추가한다", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(legacySchema);
    database.exec(await migrationPromise);
    database.exec(await stageMigrationPromise);
    database.prepare(`INSERT INTO github_apply_stage_chunks
      (job_id, chunk_index, total_chunks, checksum, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("apply-stage", 0, 2, "a".repeat(64), "[]", "2026-08-04T00:00:00.000Z");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM github_apply_stage_chunks WHERE job_id = 'apply-stage'").get().count,
      1,
    );
    assert.throws(() => {
      database.prepare(`INSERT INTO github_apply_stage_chunks
        (job_id, chunk_index, total_chunks, checksum, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run("apply-stage", 0, 2, "b".repeat(64), "[]", "2026-08-04T00:00:01.000Z");
    }, /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test("0009는 대형 저장소의 문서·작업·대상 상태를 원자 commit 전에 staging한다", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(await atomicRepositoryStageMigrationPromise);
    const tableNames = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map((row) => row.name);
    assert.ok(tableNames.includes("staged_documents"));
    assert.ok(tableNames.includes("staged_ingestion_jobs"));
    assert.ok(tableNames.includes("staged_github_document_targets"));
    assert.throws(() => {
      database.prepare(`INSERT INTO staged_github_document_targets
        (stage_id, source_key, mode, repository_owner, repository_name, relative_path,
         source_ref, commit_sha, blob_sha, source_url)
        VALUES ('stage', 'source', 'invalid', 'coreline-ai', 'repo', 'README.md',
                'main', 'commit', 'blob', 'https://github.com/coreline-ai/repo')`).run();
    }, /CHECK constraint failed/);
  } finally {
    database.close();
  }
});

function insertApply(database, nonce) {
  database.prepare(`INSERT INTO github_source_jobs (
    id, idempotency_key, kind, owner, status, input_json, created_at, updated_at
  ) VALUES (?, ?, 'apply', 'coreline-ai', 'queued', ?, ?, ?)`)
    .run(`apply-${nonce}`, `key-${nonce}`, applyInput(nonce), "2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
}

test("0007은 apply 영수증과 저장소별 단일 활성 작업 제약을 추가한다", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(legacySchema);
    insertApply(database, "first");
    database.exec(await migrationPromise);

    const jobColumns = database.prepare("PRAGMA table_info(github_source_jobs)").all().map((row) => row.name);
    const runColumns = database.prepare("PRAGMA table_info(github_sync_runs)").all().map((row) => row.name);
    assert.ok(jobColumns.includes("repository_id"));
    assert.ok(runColumns.includes("receipt_json"));
    assert.equal(
      database.prepare("SELECT repository_id FROM github_source_jobs WHERE id = 'apply-first'").get().repository_id,
      "1001",
    );

    assert.throws(() => {
      database.prepare(`INSERT INTO github_source_jobs (
        id, idempotency_key, kind, owner, repository_id, status, input_json, created_at, updated_at
      ) VALUES (?, ?, 'apply', 'coreline-ai', '1001', 'queued', ?, ?, ?)`)
        .run("apply-conflict", "key-conflict", applyInput("conflict"), "2026-08-04T00:00:01.000Z", "2026-08-04T00:00:01.000Z");
    }, /UNIQUE constraint failed/);

    database.prepare("UPDATE github_source_jobs SET status = 'completed' WHERE id = 'apply-first'").run();
    database.prepare(`INSERT INTO github_source_jobs (
      id, idempotency_key, kind, owner, repository_id, status, input_json, created_at, updated_at
    ) VALUES (?, ?, 'apply', 'coreline-ai', '1001', 'queued', ?, ?, ?)`)
      .run("apply-next", "key-next", applyInput("next"), "2026-08-04T00:00:02.000Z", "2026-08-04T00:00:02.000Z");

    database.prepare(`INSERT INTO github_sync_runs (
      id, kind, status, receipt_json, created_at, updated_at
    ) VALUES (?, 'apply', 'completed', ?, ?, ?)`)
      .run("sync-1", '{"repositoryId":"1001"}', "2026-08-04T00:00:03.000Z", "2026-08-04T00:00:03.000Z");
    assert.equal(
      database.prepare("SELECT receipt_json FROM github_sync_runs WHERE id = 'sync-1'").get().receipt_json,
      '{"repositoryId":"1001"}',
    );
  } finally {
    database.close();
  }
});
