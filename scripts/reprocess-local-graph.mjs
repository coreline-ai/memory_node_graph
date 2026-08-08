import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalD1Backup } from "./lib/local-d1-baseline.mjs";
import { resolveLocalD1Database } from "./lib/local-d1.mjs";

process.env.ATLAS_TEST_MODE = "true";
process.env.ATLAS_WRITE_ACCESS = "public";
delete process.env.ATLAS_MEMORY_STORAGE;

const args = new Set(process.argv.slice(2));
const option = (name) => process.argv.slice(2)
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const execute = args.has("--execute");
const batchSize = Math.max(1, Math.min(20, Number(option("--batch") ?? 20)));
const requestedDatabase = option("--db");
const root = resolve(new URL("..", import.meta.url).pathname);

class SqliteD1Statement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }
  bind(...bindings) { return new SqliteD1Statement(this.database, this.sql, bindings); }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.bindings),
      meta: { changes: 0 },
    };
  }
}

class SqliteD1Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.database = new DatabaseSync(filePath);
  }
  prepare(sql) { return new SqliteD1Statement(this.database, sql); }
  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.database.close(); }
}

const databasePath = await resolveLocalD1Database({ root, requested: requestedDatabase });
const adapter = new SqliteD1Database(databasePath);
globalThis.__AI_ATLAS_TEST_D1__ = adapter;

const worker = await import(new URL("../dist/server/index.js", import.meta.url).href)
  .then((module) => module.default);
const request = (path, init) => worker.fetch(
  new Request(`http://localhost${path}`, init),
  { DB: adapter, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
  { waitUntil() {}, passThroughOnException() {} },
);

const querySummary = () => {
  const scalar = (sql) => Number(adapter.database.prepare(sql).get()?.count ?? 0);
  const rows = (sql) => adapter.database.prepare(sql).all();
  return {
    documents: scalar("SELECT COUNT(*) AS count FROM documents"),
    blocks: scalar("SELECT COUNT(*) AS count FROM document_blocks"),
    entities: scalar("SELECT COUNT(*) AS count FROM entities"),
    relations: scalar("SELECT COUNT(*) AS count FROM relations"),
    enrichmentJobs: scalar("SELECT COUNT(*) AS count FROM enrichment_jobs"),
    parserVersions: rows("SELECT parser_version AS value, COUNT(*) AS count FROM documents GROUP BY parser_version ORDER BY parser_version"),
    relationOrigins: rows("SELECT origin AS value, COUNT(*) AS count FROM relations GROUP BY origin ORDER BY origin"),
    relationTypes: rows("SELECT type AS value, COUNT(*) AS count FROM relations GROUP BY type ORDER BY count DESC, type"),
    enrichmentStatuses: rows("SELECT status AS value, COUNT(*) AS count FROM enrichment_jobs GROUP BY status ORDER BY status"),
  };
};

try {
  const previewResponse = await request("/api/enrichment-jobs/reprocess");
  if (!previewResponse.ok) throw new Error(await previewResponse.text());
  const preview = await previewResponse.json();
  const before = querySummary();
  console.log(JSON.stringify({ mode: execute ? "execute" : "preview", databasePath, before, preview: preview.totals }, null, 2));
  if (!execute) {
    console.log("Preview only. Re-run with --execute to apply parser v4 and enqueue chunk jobs.");
    process.exitCode = 0;
  } else {
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const backup = await createLocalD1Backup({
      databasePath,
      reportDirectory: join(root, ".wrangler", "reports"),
    });
    const backupPath = backup.backupPath;
    console.log(`Backup: ${backupPath}`);
    console.log(`Backup receipt: ${backup.receiptPath}`);

    let completed = 0;
    let failed = 0;
    const failures = [];
    for (let offset = 0; offset < preview.documents.length; offset += batchSize) {
      const documentIds = preview.documents
        .slice(offset, offset + batchSize)
        .map((document) => document.documentId);
      const response = await request("/api/enrichment-jobs/reprocess", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentIds, includeSnapshot: false }),
      });
      if (!response.ok) throw new Error(`Batch ${offset / batchSize + 1}: ${await response.text()}`);
      const payload = await response.json();
      completed += payload.completedCount;
      failed += payload.failedCount;
      failures.push(...payload.results.filter((result) => result.status === "failed"));
      console.log(`[${Math.min(offset + batchSize, preview.documents.length)}/${preview.documents.length}] completed=${completed} failed=${failed}`);
    }

    const after = querySummary();
    const report = {
      generatedAt: new Date().toISOString(),
      databasePath,
      backupPath,
      backupReceiptPath: backup.receiptPath,
      backupSha256: backup.sha256,
      backupDataFingerprint: backup.dataFingerprint,
      preview: preview.totals,
      completed,
      failed,
      failures,
      before,
      after,
    };
    const reportDirectory = join(root, ".wrangler", "reports");
    await mkdir(reportDirectory, { recursive: true });
    const reportPath = join(reportDirectory, `full-reprocess-${stamp}.json`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ reportPath, completed, failed, after }, null, 2));
    if (failed) process.exitCode = 1;
  }
} finally {
  delete globalThis.__AI_ATLAS_TEST_D1__;
  adapter.close();
}
