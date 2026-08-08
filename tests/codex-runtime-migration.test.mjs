import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("0016은 통합 OAuth runtime 상태 테이블을 추가한다", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const migration = await readFile(
      new URL("../drizzle/0016_integrated_runtime_status.sql", import.meta.url),
      "utf8",
    );
    database.exec(migration.replaceAll("--> statement-breakpoint", ""));
    const runtimeColumns = new Set(database.prepare("PRAGMA table_info(runtime_status)")
      .all().map((row) => row.name));
    assert.equal(runtimeColumns.has("runtime_state"), true);
    assert.equal(runtimeColumns.has("runtime_message"), true);
    const githubColumns = new Set(database.prepare("PRAGMA table_info(github_runtime_status)")
      .all().map((row) => row.name));
    assert.equal(githubColumns.has("runtime_id"), true);
  } finally {
    database.close();
  }
});
