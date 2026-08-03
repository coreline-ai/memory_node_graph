import { knowledgeEdges, knowledgeNodes, type KnowledgeEdge, type KnowledgeNode } from "../../graph-data";
import type { DashboardEnrichmentJob, DashboardSnapshot, DocumentRecord, GraphSnapshot, IngestionJob } from "../graph/model";
import type { EnrichmentResult } from "../llm/enrichment-contracts";
import { getEnrichmentJobRepository } from "./enrichment-job-repository";
import type { DocumentBlock, ExtractedGraph } from "../markdown/extract-graph";
import { stableKey } from "../markdown/normalize";

type StoredDocument = DocumentRecord & {
  source: string;
  graph: ExtractedGraph;
};

type MemoryStore = {
  documents: Map<string, StoredDocument>;
  jobs: Map<string, IngestionJob>;
  enrichmentEdges: Map<string, string[]>;
};

const memoryKey = "__AI_ATLAS_DOCUMENT_STORE__";

const memoryStore = () => {
  const root = globalThis as typeof globalThis & { [memoryKey]?: MemoryStore };
  root[memoryKey] ??= { documents: new Map(), jobs: new Map(), enrichmentEdges: new Map() };
  root[memoryKey].enrichmentEdges ??= new Map();
  return root[memoryKey];
};

const database = async () => {
  if (process.env.ATLAS_MEMORY_STORAGE === "true") return null;
  try {
    const { env } = await import("cloudflare:workers");
    const candidate = env.DB;
    return candidate && typeof candidate.prepare === "function" ? candidate : null;
  } catch {
    return null;
  }
};

let schemaReady: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, file_name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, source TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, node_count INTEGER NOT NULL DEFAULT 0, edge_count INTEGER NOT NULL DEFAULT 0, parser_version TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS document_blocks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, type TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, ordinal INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, label TEXT NOT NULL, short_label TEXT NOT NULL, kind TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL, insight TEXT NOT NULL, tags_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS entity_mentions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, entity_id TEXT NOT NULL, block_id TEXT, origin TEXT NOT NULL DEFAULT 'rule')`,
  `CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL, note TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'rule', provider TEXT, provider_version TEXT, prompt_version TEXT, evidence_json TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ingestion_jobs (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, file_name TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS staged_document_blocks (stage_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, type TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_entities (stage_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, short_label TEXT NOT NULL, kind TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL, insight TEXT NOT NULL, tags_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_entity_mentions (stage_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, entity_id TEXT NOT NULL, block_id TEXT, origin TEXT NOT NULL DEFAULT 'rule', PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_relations (stage_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL, note TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'rule', provider TEXT, provider_version TEXT, prompt_version TEXT, evidence_json TEXT, created_at TEXT, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS enrichment_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL, document_hash TEXT NOT NULL, parser_version TEXT NOT NULL, provider TEXT NOT NULL, provider_version TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, lease_owner TEXT, lease_expires_at TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS connector_heartbeats (connector_id TEXT PRIMARY KEY, status TEXT NOT NULL, version TEXT NOT NULL, current_job_id TEXT, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_claim_idx ON enrichment_jobs(status, lease_expires_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_document_idx ON enrichment_jobs(document_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS connector_heartbeats_seen_idx ON connector_heartbeats(last_seen_at)`,
];

const relationMetadataColumns = [
  ["provider", "TEXT"],
  ["provider_version", "TEXT"],
  ["prompt_version", "TEXT"],
  ["evidence_json", "TEXT"],
  ["created_at", "TEXT"],
] as const;

async function ensureRelationMetadataColumns(db: D1Database, table: "relations" | "staged_relations") {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const existing = new Set(result.results.map((column) => String(column.name)));
  for (const [name, type] of relationMetadataColumns) {
    if (!existing.has(name)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
  }
}

async function ensureSchema(db: D1Database) {
  schemaReady ??= (async () => {
    await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
    await ensureRelationMetadataColumns(db, "relations");
    await ensureRelationMetadataColumns(db, "staged_relations");
    const enrichmentInfo = await db.prepare("PRAGMA table_info(enrichment_jobs)").all<{ name: string }>();
    const enrichmentColumns = new Set(enrichmentInfo.results.map((column) => String(column.name)));
    if (!enrichmentColumns.has("manual_retry_count")) {
      await db.prepare("ALTER TABLE enrichment_jobs ADD COLUMN manual_retry_count INTEGER NOT NULL DEFAULT 0").run()
        .catch((error) => {
          if (!String(error).toLowerCase().includes("duplicate column")) throw error;
        });
    }
    if (!enrichmentColumns.has("last_manual_retry_at")) {
      await db.prepare("ALTER TABLE enrichment_jobs ADD COLUMN last_manual_retry_at TEXT").run()
        .catch((error) => {
          if (!String(error).toLowerCase().includes("duplicate column")) throw error;
        });
    }
  })();
  await schemaReady;
}

const asDocument = (row: Record<string, unknown>): DocumentRecord => ({
  id: String(row.id),
  fileName: String(row.file_name),
  normalizedName: String(row.normalized_name),
  size: Number(row.size),
  hash: String(row.hash),
  status: String(row.status) as DocumentRecord["status"],
  nodeCount: Number(row.node_count),
  edgeCount: Number(row.edge_count),
  parserVersion: String(row.parser_version),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  error: row.error ? String(row.error) : undefined,
});

const asJob = (row: Record<string, unknown>): IngestionJob => ({
  id: String(row.id),
  documentId: String(row.document_id),
  fileName: String(row.file_name),
  status: String(row.status) as IngestionJob["status"],
  progress: Number(row.progress),
  message: String(row.message),
  createdAt: String(row.created_at),
  completedAt: row.completed_at ? String(row.completed_at) : undefined,
});

export async function findDocumentByName(normalizedName: string) {
  const db = await database();
  if (!db) {
    return [...memoryStore().documents.values()].find(
      (document) => document.normalizedName === normalizedName,
    );
  }
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM documents WHERE normalized_name = ? LIMIT 1")
    .bind(normalizedName)
    .first<Record<string, unknown>>();
  return row ? { ...asDocument(row), source: String(row.source) } : null;
}

export async function findDocumentById(id: string) {
  const db = await database();
  if (!db) return memoryStore().documents.get(id) ?? null;
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM documents WHERE id = ? LIMIT 1")
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? { ...asDocument(row), source: String(row.source) } : null;
}

export async function saveDocument(input: {
  document: DocumentRecord;
  source: string;
  graph: ExtractedGraph;
  job: IngestionJob;
}) {
  const db = await database();
  if (!db) {
    if (
      process.env.ATLAS_TEST_MODE === "true" &&
      process.env.ATLAS_TEST_FAIL_SAVE === input.document.fileName
    ) {
      throw new Error("테스트용 저장 실패");
    }
    memoryStore().documents.set(input.document.id, {
      ...input.document,
      source: input.source,
      graph: input.graph,
    });
    memoryStore().jobs.set(input.job.id, input.job);
    return;
  }
  await ensureSchema(db);
  const { document, source, graph, job } = input;
  const stageId = job.id;
  const statements: D1PreparedStatement[] = [];

  graph.blocks.forEach((block: DocumentBlock) => {
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_document_blocks (stage_id, id, document_id, type, depth, text, ordinal) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(stageId, block.id, document.id, block.type, block.depth, block.text, block.ordinal),
    );
  });
  graph.nodes.forEach((node) => {
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_entities (stage_id, id, label, short_label, kind, domain, summary, insight, tags_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(stageId, node.id, node.label, node.shortLabel, node.kind, node.domain, node.summary, node.insight, JSON.stringify(node.tags), document.updatedAt),
    );
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_entity_mentions (stage_id, id, document_id, entity_id, block_id, origin) VALUES (?, ?, ?, ?, NULL, 'rule')")
        .bind(stageId, `mention:${stableKey(`${document.id}:${node.id}`)}`, document.id, node.id),
    );
  });
  graph.edges.forEach((edge) => {
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_relations (stage_id, id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rule', 'markdown-ast', ?, NULL, '[]', ?)")
        .bind(stageId, `relation:${stableKey(`${document.id}:${edge.source}:${edge.target}:${edge.type}`)}`, document.id, edge.source, edge.target, edge.type, edge.confidence, edge.note, document.parserVersion, document.updatedAt),
    );
  });

  const cleanupStage = () => db.batch([
    db.prepare("DELETE FROM staged_relations WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_entities WHERE stage_id = ?").bind(stageId),
  ]);

  try {
    for (let index = 0; index < statements.length; index += 90) {
      await db.batch(statements.slice(index, index + 90));
    }

    await db.batch([
      db.prepare(`INSERT INTO entities (id, label, short_label, kind, domain, summary, insight, tags_json, updated_at)
        SELECT id, label, short_label, kind, domain, summary, insight, tags_json, updated_at FROM staged_entities WHERE stage_id = ? AND 1 = 1
        ON CONFLICT(id) DO UPDATE SET label=excluded.label, short_label=excluded.short_label, kind=excluded.kind, domain=excluded.domain, summary=excluded.summary, insight=excluded.insight, tags_json=excluded.tags_json, updated_at=excluded.updated_at`)
        .bind(stageId),
      db.prepare("DELETE FROM relations WHERE document_id = ?").bind(document.id),
      db.prepare("DELETE FROM entity_mentions WHERE document_id = ?").bind(document.id),
      db.prepare("DELETE FROM document_blocks WHERE document_id = ?").bind(document.id),
      db.prepare("INSERT INTO document_blocks (id, document_id, type, depth, text, ordinal) SELECT id, document_id, type, depth, text, ordinal FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
      db.prepare("INSERT INTO entity_mentions (id, document_id, entity_id, block_id, origin) SELECT id, document_id, entity_id, block_id, origin FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
      db.prepare("INSERT INTO relations (id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at) SELECT id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at FROM staged_relations WHERE stage_id = ?").bind(stageId),
      db.prepare(`INSERT INTO documents (id, file_name, normalized_name, source, size, hash, status, node_count, edge_count, parser_version, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET file_name=excluded.file_name, normalized_name=excluded.normalized_name, source=excluded.source, size=excluded.size, hash=excluded.hash, status=excluded.status, node_count=excluded.node_count, edge_count=excluded.edge_count, parser_version=excluded.parser_version, error=excluded.error, updated_at=excluded.updated_at`)
        .bind(document.id, document.fileName, document.normalizedName, source, document.size, document.hash, document.status, document.nodeCount, document.edgeCount, document.parserVersion, document.error ?? null, document.createdAt, document.updatedAt),
      db.prepare("INSERT OR REPLACE INTO ingestion_jobs (id, document_id, file_name, status, progress, message, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(job.id, job.documentId, job.fileName, job.status, job.progress, job.message, job.createdAt, job.completedAt ?? null),
      db.prepare("DELETE FROM staged_relations WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_entities WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)"),
    ]);
  } catch (error) {
    await cleanupStage().catch(() => undefined);
    throw error;
  }
}

export async function saveUnchangedJob(job: IngestionJob) {
  const db = await database();
  if (!db) {
    memoryStore().jobs.set(job.id, job);
    return;
  }
  await ensureSchema(db);
  await db.prepare("INSERT OR REPLACE INTO ingestion_jobs (id, document_id, file_name, status, progress, message, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(job.id, job.documentId, job.fileName, job.status, job.progress, job.message, job.createdAt, job.completedAt ?? null)
    .run();
}

export async function deleteDocument(id: string) {
  const db = await database();
  if (!db) {
    const removed = memoryStore().documents.delete(id);
    await (await getEnrichmentJobRepository()).deleteForDocument(id);
    return removed;
  }
  await ensureSchema(db);
  await db.batch([
    db.prepare("DELETE FROM relations WHERE document_id = ?").bind(id),
    db.prepare("DELETE FROM entity_mentions WHERE document_id = ?").bind(id),
    db.prepare("DELETE FROM document_blocks WHERE document_id = ?").bind(id),
    db.prepare("DELETE FROM ingestion_jobs WHERE document_id = ?").bind(id),
    db.prepare("DELETE FROM enrichment_jobs WHERE document_id = ?").bind(id),
    db.prepare("DELETE FROM documents WHERE id = ?").bind(id),
    db.prepare("DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)"),
  ]);
  return true;
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  const db = await database();
  let documents: DocumentRecord[];
  let jobs: IngestionJob[];
  if (!db) {
    documents = [...memoryStore().documents.values()];
    jobs = [...memoryStore().jobs.values()];
  } else {
    await ensureSchema(db);
    const [documentResult, jobResult] = await Promise.all([
      db.prepare("SELECT * FROM documents ORDER BY updated_at DESC").all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM ingestion_jobs ORDER BY created_at DESC LIMIT 20").all<Record<string, unknown>>(),
    ]);
    documents = documentResult.results.map(asDocument);
    jobs = jobResult.results.map(asJob);
  }
  const enrichmentRepository = await getEnrichmentJobRepository();
  const [enrichmentRecords, heartbeats] = await Promise.all([
    enrichmentRepository.list(),
    enrichmentRepository.listConnectorHeartbeats(),
  ]);
  const recentJobs = [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  const enrichmentJobs: DashboardEnrichmentJob[] = enrichmentRecords
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map((job) => ({
      id: job.id,
      documentId: job.documentId,
      status: job.status,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      manualRetryCount: job.manualRetryCount,
      maxManualRetries: 2,
      providerVersion: job.providerVersion,
      promptVersion: job.promptVersion,
      relationCount: job.result?.relations.length ?? 0,
      warningCount: job.result?.warnings.length ?? 0,
      inputTokens: job.result?.usage?.inputTokens,
      outputTokens: job.result?.usage?.outputTokens,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
    }));
  const now = Date.now();
  const onlineHeartbeats = heartbeats.filter((heartbeat) =>
    heartbeat.status === "online" && now - Date.parse(heartbeat.lastSeenAt) <= 45_000,
  );
  const latestHeartbeat = heartbeats[0];
  const queuedJobs = enrichmentRecords.filter((job) => job.status === "queued").length;
  const activeJobs = enrichmentRecords.filter((job) => job.status === "leased" || job.status === "running").length;
  return {
    documents: [...documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    jobs: recentJobs,
    enrichmentJobs,
    connector: {
      status: onlineHeartbeats.length ? "online" : "offline",
      onlineCount: onlineHeartbeats.length,
      queuedJobs,
      activeJobs,
      lastSeenAt: latestHeartbeat?.lastSeenAt,
      currentJobId: onlineHeartbeats.find((heartbeat) => heartbeat.currentJobId)?.currentJobId,
    },
    totals: {
      documents: documents.length,
      nodes: documents.reduce((sum, document) => sum + document.nodeCount, 0),
      edges: documents.reduce((sum, document) => sum + document.edgeCount, 0),
      processing: documents.filter((document) => ["queued", "validating", "parsing"].includes(document.status)).length,
      failed: documents.filter((document) => document.status === "failed").length,
      enrichmentQueued: queuedJobs,
      enrichmentActive: activeJobs,
      enrichmentWarnings: enrichmentRecords.filter((job) => job.status === "warning" || job.status === "failed").length,
    },
    storage: db ? "d1" : "memory",
  };
}

export async function getGraphSnapshot(): Promise<GraphSnapshot> {
  const db = await database();
  let nodes: KnowledgeNode[] = [];
  let edges: KnowledgeEdge[] = [];
  let documentCount = 0;
  if (!db) {
    const documents = [...memoryStore().documents.values()];
    documentCount = documents.length;
    const nodeMap = new Map<string, KnowledgeNode>();
    const edgeMap = new Map<string, KnowledgeEdge>();
    documents.forEach((document) => {
      document.graph.nodes.forEach((node) => nodeMap.set(node.id, node));
      document.graph.edges.forEach((edge) => edgeMap.set(`${edge.source}|${edge.target}|${edge.type}`, edge));
    });
    nodes = [...nodeMap.values()];
    edges = [...edgeMap.values()];
  } else {
    await ensureSchema(db);
    const [documentResult, nodeResult, edgeResult] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status IN ('completed', 'unchanged')").first<{ count: number }>(),
      db.prepare("SELECT DISTINCT e.* FROM entities e INNER JOIN entity_mentions m ON m.entity_id = e.id").all<Record<string, unknown>>(),
      db.prepare("SELECT DISTINCT source_id, target_id, type, confidence, note FROM relations").all<Record<string, unknown>>(),
    ]);
    documentCount = Number(documentResult?.count ?? 0);
    nodes = nodeResult.results.map((row) => ({
      id: String(row.id),
      label: String(row.label),
      shortLabel: String(row.short_label),
      kind: String(row.kind) as KnowledgeNode["kind"],
      domain: String(row.domain) as KnowledgeNode["domain"],
      summary: String(row.summary),
      insight: String(row.insight),
      tags: JSON.parse(String(row.tags_json)) as string[],
    }));
    edges = edgeResult.results.map((row) => ({
      source: String(row.source_id),
      target: String(row.target_id),
      type: String(row.type) as KnowledgeEdge["type"],
      confidence: Number(row.confidence),
      note: String(row.note),
    }));
  }

  if (documentCount === 0 || nodes.length === 0) {
    return {
      nodes: knowledgeNodes,
      edges: knowledgeEdges,
      meta: {
        source: "demo",
        provider: "built-in",
        generatedAt: new Date().toISOString(),
        documentCount: 0,
        message: "내장 데모 데이터입니다. 대시보드에서 Markdown을 추가할 수 있습니다.",
      },
    };
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
    meta: {
      source: "documents",
      provider: "markdown-ast",
      generatedAt: new Date().toISOString(),
      documentCount,
    },
  };
}

export async function mergeMemoryEnrichmentResult(
  documentId: string,
  result: EnrichmentResult,
) {
  const db = await database();
  if (db) return 0;
  const document = memoryStore().documents.get(documentId);
  if (!document || document.hash !== result.documentHash) return 0;
  const keys = new Set(document.graph.edges.map(
    (edge) => `${edge.source}|${edge.target}|${edge.type}`,
  ));
  let added = 0;
  const addedKeys: string[] = [];
  result.relations.forEach((relation) => {
    const key = `${relation.source}|${relation.target}|${relation.type}`;
    if (keys.has(key)) return;
    keys.add(key);
    document.graph.edges.push({
      source: relation.source,
      target: relation.target,
      type: relation.type,
      confidence: relation.confidence,
      note: relation.note,
    });
    addedKeys.push(key);
    added += 1;
  });
  document.edgeCount = document.graph.edges.length;
  document.updatedAt = new Date().toISOString();
  memoryStore().enrichmentEdges.set(result.jobId, addedKeys);
  return added;
}

export async function removeMemoryEnrichmentResult(jobId: string, documentId: string) {
  const db = await database();
  if (db) return 0;
  const store = memoryStore();
  const document = store.documents.get(documentId);
  const keys = new Set(store.enrichmentEdges.get(jobId) ?? []);
  if (!document || keys.size === 0) return 0;
  const before = document.graph.edges.length;
  document.graph.edges = document.graph.edges.filter(
    (edge) => !keys.has(`${edge.source}|${edge.target}|${edge.type}`),
  );
  store.enrichmentEdges.delete(jobId);
  document.edgeCount = document.graph.edges.length;
  document.updatedAt = new Date().toISOString();
  return before - document.graph.edges.length;
}
