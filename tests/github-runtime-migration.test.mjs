import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("0015는 통합 GitHub runtime generation claim 경계를 추가한다", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE github_source_jobs (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, lease_expires_at TEXT, created_at TEXT NOT NULL
      );
    `);
    const migration = await readFile(
      new URL("../drizzle/0015_integrated_github_runtime.sql", import.meta.url),
      "utf8",
    );
    database.exec(migration.replaceAll("--> statement-breakpoint", ""));
    const columns = new Set(database.prepare("PRAGMA table_info(github_source_jobs)")
      .all().map((row) => row.name));
    const indexes = new Set(database.prepare("PRAGMA index_list(github_source_jobs)")
      .all().map((row) => row.name));
    assert.equal(columns.has("runtime_version"), true);
    assert.equal(indexes.has("github_source_jobs_runtime_claim_idx"), true);
  } finally {
    database.close();
  }
});
