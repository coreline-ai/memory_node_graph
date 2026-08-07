import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveLocalD1Database } from "./lib/local-d1.mjs";

process.env.ATLAS_TEST_MODE = "true";
process.env.ATLAS_WRITE_ACCESS = "public";
delete process.env.ATLAS_MEMORY_STORAGE;

const option = (name) => process.argv.slice(2)
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const root = resolve(new URL("..", import.meta.url).pathname);
const databasePath = await resolveLocalD1Database({ root, requested: option("--db") });

class Statement {
  constructor(database, sql, bindings = []) { Object.assign(this, { database, sql, bindings }); }
  bind(...bindings) { return new Statement(this.database, this.sql, bindings); }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first() { return this.database.prepare(this.sql).get(...this.bindings) ?? null; }
  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } };
  }
}

class Database {
  constructor(path) { this.database = new DatabaseSync(path); }
  prepare(sql) { return new Statement(this.database, sql); }
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

const database = new Database(databasePath);
globalThis.__AI_ATLAS_TEST_D1__ = database;
const repositoryId = option("--repository") ?? String(database.database.prepare(`SELECT repository_id
  FROM documents WHERE repository_id IS NOT NULL
  GROUP BY repository_id ORDER BY COUNT(*) DESC, repository_id LIMIT 1`).get()?.repository_id ?? "");
const worker = await import(new URL("../dist/server/index.js", import.meta.url).href)
  .then((module) => module.default);

const requestJson = async (path) => {
  const startedAt = performance.now();
  const response = await worker.fetch(
    new Request(`http://localhost${path}`),
    { DB: database, ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  const payload = await response.json();
  const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(payload)}`);
  return { payload, elapsedMs };
};

const graphSummary = ({ payload, elapsedMs }) => {
  const layers = {};
  for (const edge of payload.edges ?? []) layers[edge.layer ?? "unspecified"] = (layers[edge.layer ?? "unspecified"] ?? 0) + 1;
  const analytics = payload.meta?.analytics;
  return {
    elapsedMs,
    nodes: payload.nodes?.length ?? 0,
    edges: payload.edges?.length ?? 0,
    layers,
    meta: {
      ...payload.meta,
      analytics: analytics ? {
        algorithm: analytics.algorithm,
        communityCount: analytics.communityCount,
        componentCount: analytics.componentCount,
        density: analytics.density,
        leafRatio: analytics.leafRatio,
        nonStructuralRatio: analytics.nonStructuralRatio,
        inferredEvidenceCoverage: analytics.inferredEvidenceCoverage,
      } : undefined,
    },
  };
};

try {
  const dashboard = await requestJson("/api/documents");
  const corpus = await requestJson("/api/graph?scope=corpus");
  const overview = await requestJson("/api/graph?scope=overview");
  const repository = repositoryId
    ? await requestJson(`/api/graph?scope=repository&repositoryId=${encodeURIComponent(repositoryId)}`)
    : null;
  const goldGraph = await requestJson("/api/graph?showcase=gold");
  const performanceFixture = await requestJson("/api/graph?showcase=max");
  console.log(JSON.stringify({
    databasePath,
    dashboard: {
      elapsedMs: dashboard.elapsedMs,
      totals: dashboard.payload.totals,
      storage: dashboard.payload.storage,
      recentEnrichmentJobs: dashboard.payload.enrichmentJobs.length,
    },
    corpus: graphSummary(corpus),
    overview: graphSummary(overview),
    repositoryId,
    repository: repository ? graphSummary(repository) : null,
    goldGraph: graphSummary(goldGraph),
    performanceFixture: graphSummary(performanceFixture),
  }, null, 2));
} finally {
  delete globalThis.__AI_ATLAS_TEST_D1__;
  database.close();
}
