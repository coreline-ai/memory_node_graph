import {
  knowledgeEdges,
  knowledgeNodes,
  type KnowledgeEdge,
  type KnowledgeNode,
  type RelationEvidence,
} from "../../graph-data";
import type {
  DashboardEnrichmentJob,
  DashboardSnapshot,
  DocumentRecord,
  DocumentSourceDescriptor,
  DocumentSourceKey,
  GitHubRepositoryStorageSummary,
  GraphDocumentSummary,
  GraphNodeSearchResult,
  GraphSnapshot,
  IngestionJob,
} from "../graph/model";
import type { EnrichmentResult } from "../llm/enrichment-contracts";
import { INTEGRATED_CODEX_PROVIDER_VERSION } from "../llm/codex-runtime-status";
import { getEnrichmentJobRepository } from "./enrichment-job-repository";
import {
  GRAPH_CORPUS_EDGE_BUDGET,
  GRAPH_CORPUS_NODE_BUDGET,
} from "../graph/scope-projection";
import type { DocumentBlock, ExtractedGraph } from "../markdown/extract-graph";
import {
  parseGitHubApplyReceipt,
  type GitHubApplyReceipt,
} from "../github/source-job-contracts";
import {
  createGitHubDocumentSourceDescriptor,
  createManualDocumentSourceDescriptor,
  documentSourceKey,
} from "../ingestion/document-source";
import {
  assertD1AtomicBatchLimit,
  chunkD1Statements,
} from "./d1-batch-policy";
import { createGraphSnapshotCache } from "../graph/snapshot-cache";
import { graphRevisionFromState } from "../graph/graph-revision";
import {
  graphNodeLexicalMatch,
  type GraphRetrievalCitation,
  type GraphRetrievalSource,
  type NormalizedGraphQuestion,
} from "../graph/graph-retrieval";

type StoredDocument = DocumentRecord & {
  source: string;
  sourceKey: DocumentSourceKey;
  sourceDescriptor: DocumentSourceDescriptor;
  graph: ExtractedGraph;
};

type MemoryStore = {
  documents: Map<string, StoredDocument>;
  jobs: Map<string, IngestionJob>;
  enrichmentEdges: Map<string, string[]>;
  githubApplyReceipts: Map<string, GitHubApplyReceipt>;
};

const memoryKey = "__AI_ATLAS_DOCUMENT_STORE__";
const testDatabaseKey = "__AI_ATLAS_TEST_D1__";

// Persistence IDs must not use the 32-bit UI/layout hash. With tens of
// thousands of mentions, FNV-1a collisions are realistic and can abort an
// otherwise valid repository-wide atomic Apply. Length-prefixed components
// preserve the complete identity tuple without relying on a probabilistic hash.
const graphStorageId = (prefix: string, parts: readonly string[]) =>
  `${prefix}:${parts.map((part) => `${part.length}:${part}`).join("")}`;

export const entityMentionStorageId = (documentId: string, entityId: string) =>
  graphStorageId("mention", [documentId, entityId]);

export const relationStorageId = (
  documentId: string,
  sourceId: string,
  targetId: string,
  type: string,
) => graphStorageId("relation", [documentId, sourceId, targetId, type]);

const memoryStore = () => {
  const root = globalThis as typeof globalThis & { [memoryKey]?: MemoryStore };
  root[memoryKey] ??= {
    documents: new Map(),
    jobs: new Map(),
    enrichmentEdges: new Map(),
    githubApplyReceipts: new Map(),
  };
  root[memoryKey].enrichmentEdges ??= new Map();
  root[memoryKey].githubApplyReceipts ??= new Map();
  for (const document of root[memoryKey].documents.values()) {
    if (!document.sourceDescriptor) {
      document.sourceDescriptor = createManualDocumentSourceDescriptor(document.fileName);
    }
    if (!document.sourceKey) document.sourceKey = documentSourceKey(document.sourceDescriptor);
  }
  return root[memoryKey];
};

const database = async () => {
  if (process.env.ATLAS_MEMORY_STORAGE === "true") return null;
  if (process.env.ATLAS_TEST_MODE === "true") {
    const testDatabase = (globalThis as typeof globalThis & {
      [testDatabaseKey]?: D1Database;
    })[testDatabaseKey];
    if (testDatabase) return testDatabase;
  }
  try {
    const { env } = await import("cloudflare:workers");
    const candidate = env.DB;
    return candidate && typeof candidate.prepare === "function" ? candidate : null;
  } catch {
    return null;
  }
};

let schemaReady: Promise<void> | null = null;
const graphSearchReadyByDatabase = new WeakMap<object, Promise<boolean>>();
const corpusSnapshotCaches = new WeakMap<object, ReturnType<typeof createGraphSnapshotCache>>();

const corpusSnapshotCacheFor = (db: D1Database) => {
  const key = db as unknown as object;
  const existing = corpusSnapshotCaches.get(key);
  if (existing) return existing;
  const created = createGraphSnapshotCache();
  corpusSnapshotCaches.set(key, created);
  return created;
};

type GraphRevisionRows = {
  documentResult: { count?: number; version?: string } | null;
  entityResult: { count?: number } | null;
  mentionResult: { count?: number } | null;
  relationResult: { count?: number; version?: number; updatedAt?: string } | null;
};

const graphRevisionFromRows = (rows: GraphRevisionRows) => graphRevisionFromState({
  documents: Number(rows.documentResult?.count ?? 0),
  documentVersion: String(rows.documentResult?.version ?? ""),
  entities: Number(rows.entityResult?.count ?? 0),
  mentions: Number(rows.mentionResult?.count ?? 0),
  relations: Number(rows.relationResult?.count ?? 0),
  relationVersion: Number(rows.relationResult?.version ?? 0),
  relationUpdatedAt: String(rows.relationResult?.updatedAt ?? ""),
});

async function graphRevisionRows(db: D1Database): Promise<GraphRevisionRows> {
  const [documentResult, entityResult, mentionResult, relationResult] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS version
      FROM documents WHERE status IN ('completed', 'unchanged')`)
      .first<{ count: number; version: string }>(),
    db.prepare("SELECT COUNT(*) AS count FROM entities").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM entity_mentions").first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count, COALESCE(MAX(rowid), 0) AS version,
      COALESCE(MAX(created_at), '') AS updatedAt FROM relations`)
      .first<{ count: number; version: number; updatedAt: string }>(),
  ]);
  return { documentResult, entityResult, mentionResult, relationResult };
}

const memoryGraphRevision = () => {
  const documents = [...memoryStore().documents.values()];
  return graphRevisionFromState({
    documents: documents.length,
    documentVersion: documents.reduce(
      (latest, document) => document.updatedAt > latest ? document.updatedAt : latest,
      "",
    ),
    entities: documents.reduce((sum, document) => sum + document.nodeCount, 0),
    mentions: documents.reduce((sum, document) => sum + document.nodeCount, 0),
    relations: documents.reduce((sum, document) => sum + document.edgeCount, 0),
    relationVersion: documents.reduce((sum, document) => sum + document.edgeCount, 0),
    relationUpdatedAt: documents.reduce(
      (latest, document) => document.updatedAt > latest ? document.updatedAt : latest,
      "",
    ),
  });
};

export async function getGraphRevision() {
  const db = await database();
  if (!db) return memoryGraphRevision();
  await ensureSchema(db);
  return graphRevisionFromRows(await graphRevisionRows(db));
}

const documentsTableSql = (table: string, ifNotExists = false) =>
  `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${table} (` +
  "id TEXT PRIMARY KEY, file_name TEXT NOT NULL, normalized_name TEXT NOT NULL, source TEXT NOT NULL, " +
  "source_type TEXT NOT NULL DEFAULT 'manual', source_key TEXT NOT NULL, repository_id TEXT, " +
  "repository_owner TEXT, repository_name TEXT, relative_path TEXT, source_ref TEXT, commit_sha TEXT, " +
  "blob_sha TEXT, source_url TEXT, last_seen_sync_id TEXT, size INTEGER NOT NULL, hash TEXT NOT NULL, " +
  "status TEXT NOT NULL, node_count INTEGER NOT NULL DEFAULT 0, edge_count INTEGER NOT NULL DEFAULT 0, " +
  "parser_version TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)";

const schemaStatements = [
  documentsTableSql("documents", true),
  `CREATE TABLE IF NOT EXISTS document_blocks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, type TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, ordinal INTEGER NOT NULL, source_url TEXT)`,
  `CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, label TEXT NOT NULL, short_label TEXT NOT NULL, kind TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL, insight TEXT NOT NULL, tags_json TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS entity_mentions (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, entity_id TEXT NOT NULL, block_id TEXT, source_url TEXT, origin TEXT NOT NULL DEFAULT 'rule')`,
  `CREATE TABLE IF NOT EXISTS relations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL, note TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'rule', provider TEXT, provider_version TEXT, prompt_version TEXT, evidence_json TEXT, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ingestion_jobs (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, file_name TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS staged_document_blocks (stage_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, type TEXT NOT NULL, depth INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, ordinal INTEGER NOT NULL, source_url TEXT, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_documents (stage_id TEXT NOT NULL, id TEXT NOT NULL, file_name TEXT NOT NULL, normalized_name TEXT NOT NULL, source TEXT NOT NULL, source_type TEXT NOT NULL, source_key TEXT NOT NULL, repository_id TEXT, repository_owner TEXT, repository_name TEXT, relative_path TEXT, source_ref TEXT, commit_sha TEXT, blob_sha TEXT, source_url TEXT, last_seen_sync_id TEXT, size INTEGER NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, node_count INTEGER NOT NULL, edge_count INTEGER NOT NULL, parser_version TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_ingestion_jobs (stage_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, file_name TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_github_document_targets (stage_id TEXT NOT NULL, source_key TEXT NOT NULL, mode TEXT NOT NULL, repository_owner TEXT NOT NULL, repository_name TEXT NOT NULL, relative_path TEXT NOT NULL, source_ref TEXT NOT NULL, commit_sha TEXT NOT NULL, blob_sha TEXT NOT NULL, source_url TEXT NOT NULL, PRIMARY KEY (stage_id, source_key))`,
  `CREATE TABLE IF NOT EXISTS staged_entities (stage_id TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL, short_label TEXT NOT NULL, kind TEXT NOT NULL, domain TEXT NOT NULL, summary TEXT NOT NULL, insight TEXT NOT NULL, tags_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_entity_mentions (stage_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, entity_id TEXT NOT NULL, block_id TEXT, source_url TEXT, origin TEXT NOT NULL DEFAULT 'rule', PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS staged_relations (stage_id TEXT NOT NULL, id TEXT NOT NULL, document_id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL, type TEXT NOT NULL, confidence REAL NOT NULL, note TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'rule', provider TEXT, provider_version TEXT, prompt_version TEXT, evidence_json TEXT, created_at TEXT, PRIMARY KEY (stage_id, id))`,
  `CREATE TABLE IF NOT EXISTS enrichment_jobs (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, document_id TEXT NOT NULL, document_hash TEXT NOT NULL, parser_version TEXT NOT NULL, provider TEXT NOT NULL, provider_version TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, lease_owner TEXT, lease_expires_at TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS runtime_status (runtime_id TEXT PRIMARY KEY, status TEXT NOT NULL, version TEXT NOT NULL, current_job_id TEXT, runtime_state TEXT, runtime_message TEXT, run_mode TEXT, max_jobs INTEGER, max_runtime_ms INTEGER, processed_jobs INTEGER, succeeded_jobs INTEGER, warning_jobs INTEGER, failed_jobs INTEGER, stop_reason TEXT, started_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS github_repositories (repository_id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, visibility TEXT NOT NULL, is_private INTEGER NOT NULL DEFAULT 0, is_fork INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, is_template INTEGER NOT NULL DEFAULT 0, default_branch TEXT NOT NULL, sync_enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'discovered', last_seen_at TEXT NOT NULL, last_synced_at TEXT, error_code TEXT, error_message TEXT)`,
  `CREATE TABLE IF NOT EXISTS github_sync_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, selection_digest TEXT, manifest_digest TEXT, discovered_count INTEGER NOT NULL DEFAULT 0, selected_count INTEGER NOT NULL DEFAULT 0, changed_count INTEGER NOT NULL DEFAULT 0, unchanged_count INTEGER NOT NULL DEFAULT 0, deleted_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, receipt_json TEXT, error_code TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_claim_idx ON enrichment_jobs(status, lease_expires_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_provider_claim_idx ON enrichment_jobs(provider_version, status, lease_expires_at, created_at)`,
  `CREATE INDEX IF NOT EXISTS enrichment_jobs_document_idx ON enrichment_jobs(document_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS runtime_status_seen_idx ON runtime_status(last_seen_at)`,
  `CREATE INDEX IF NOT EXISTS github_repositories_selection_idx ON github_repositories(sync_enabled, status)`,
  `CREATE INDEX IF NOT EXISTS github_sync_runs_status_idx ON github_sync_runs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS relations_source_idx ON relations(source_id)`,
  `CREATE INDEX IF NOT EXISTS relations_target_idx ON relations(target_id)`,
  `CREATE INDEX IF NOT EXISTS relations_document_idx ON relations(document_id)`,
  `CREATE INDEX IF NOT EXISTS entity_mentions_document_idx ON entity_mentions(document_id)`,
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

async function ensureSourceUrlColumn(
  db: D1Database,
  table: "document_blocks" | "entity_mentions" | "staged_document_blocks" | "staged_entity_mentions",
) {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if (!result.results.some((column) => String(column.name) === "source_url")) {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN source_url TEXT`).run();
  }
}

async function ensureDocumentSourceSchema(db: D1Database) {
  const result = await db.prepare("PRAGMA table_info(documents)").all<{ name: string }>();
  const columns = new Set(result.results.map((column) => String(column.name)));
  if (!columns.has("source_key")) {
    const migrationTable = "documents_source_migration";
    await db.batch([
      db.prepare(`DROP TABLE IF EXISTS ${migrationTable}`),
      db.prepare(documentsTableSql(migrationTable)),
      db.prepare(`INSERT INTO ${migrationTable} (
        id, file_name, normalized_name, source, source_type, source_key,
        size, hash, status, node_count, edge_count, parser_version, error, created_at, updated_at
      ) SELECT
        id, file_name, normalized_name, source, 'manual', 'manual:' || normalized_name,
        size, hash, status, node_count, edge_count, parser_version, error, created_at, updated_at
      FROM documents`),
      db.prepare("DROP TABLE documents"),
      db.prepare(`ALTER TABLE ${migrationTable} RENAME TO documents`),
    ]);
  }
  await db.batch([
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS documents_source_key_unique ON documents(source_key)"),
    db.prepare("CREATE INDEX IF NOT EXISTS documents_repository_idx ON documents(repository_id, relative_path)"),
  ]);
}

async function ensureSchema(db: D1Database) {
  schemaReady ??= (async () => {
    await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
    await ensureDocumentSourceSchema(db);
    await ensureRelationMetadataColumns(db, "relations");
    await ensureRelationMetadataColumns(db, "staged_relations");
    await ensureSourceUrlColumn(db, "document_blocks");
    await ensureSourceUrlColumn(db, "entity_mentions");
    await ensureSourceUrlColumn(db, "staged_document_blocks");
    await ensureSourceUrlColumn(db, "staged_entity_mentions");
    const syncRunInfo = await db.prepare("PRAGMA table_info(github_sync_runs)").all<{ name: string }>();
    if (!syncRunInfo.results.some((column) => String(column.name) === "receipt_json")) {
      await db.prepare("ALTER TABLE github_sync_runs ADD COLUMN receipt_json TEXT").run()
        .catch((error) => {
          if (!String(error).toLowerCase().includes("duplicate column")) throw error;
        });
    }
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

async function ensureGraphSearchSchema(db: D1Database) {
  const key = db as unknown as object;
  const existing = graphSearchReadyByDatabase.get(key);
  if (existing) return existing;
  const ready = (async () => {
    try {
      const statements = [
        `CREATE VIRTUAL TABLE IF NOT EXISTS graph_entity_fts USING fts5(
          entity_id UNINDEXED, label, summary, tags, tokenize='unicode61'
        )`,
        `CREATE VIRTUAL TABLE IF NOT EXISTS graph_block_fts USING fts5(
          block_id UNINDEXED, text, tokenize='unicode61'
        )`,
        `CREATE TRIGGER IF NOT EXISTS graph_entity_fts_insert AFTER INSERT ON entities BEGIN
          DELETE FROM graph_entity_fts WHERE entity_id = NEW.id;
          INSERT INTO graph_entity_fts(entity_id, label, summary, tags)
          VALUES (NEW.id, NEW.label, NEW.summary, NEW.tags_json);
        END`,
        `CREATE TRIGGER IF NOT EXISTS graph_entity_fts_update AFTER UPDATE ON entities BEGIN
          DELETE FROM graph_entity_fts WHERE entity_id = OLD.id;
          INSERT INTO graph_entity_fts(entity_id, label, summary, tags)
          VALUES (NEW.id, NEW.label, NEW.summary, NEW.tags_json);
        END`,
        `CREATE TRIGGER IF NOT EXISTS graph_entity_fts_delete AFTER DELETE ON entities BEGIN
          DELETE FROM graph_entity_fts WHERE entity_id = OLD.id;
        END`,
        `CREATE TRIGGER IF NOT EXISTS graph_block_fts_insert AFTER INSERT ON document_blocks BEGIN
          DELETE FROM graph_block_fts WHERE block_id = NEW.id;
          INSERT INTO graph_block_fts(block_id, text) VALUES (NEW.id, NEW.text);
        END`,
        `CREATE TRIGGER IF NOT EXISTS graph_block_fts_update AFTER UPDATE ON document_blocks BEGIN
          DELETE FROM graph_block_fts WHERE block_id = OLD.id;
          INSERT INTO graph_block_fts(block_id, text) VALUES (NEW.id, NEW.text);
        END`,
        `CREATE TRIGGER IF NOT EXISTS graph_block_fts_delete AFTER DELETE ON document_blocks BEGIN
          DELETE FROM graph_block_fts WHERE block_id = OLD.id;
        END`,
      ];
      await db.batch(statements.map((statement) => db.prepare(statement)));
      const [entityCount, entitySearchCount, blockCount, blockSearchCount] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS count FROM entities").first<{ count: number }>(),
        db.prepare("SELECT COUNT(*) AS count FROM graph_entity_fts").first<{ count: number }>(),
        db.prepare("SELECT COUNT(*) AS count FROM document_blocks").first<{ count: number }>(),
        db.prepare("SELECT COUNT(*) AS count FROM graph_block_fts").first<{ count: number }>(),
      ]);
      if (Number(entityCount?.count ?? 0) !== Number(entitySearchCount?.count ?? 0)) {
        await db.batch([
          db.prepare("DELETE FROM graph_entity_fts"),
          db.prepare(`INSERT INTO graph_entity_fts(entity_id, label, summary, tags)
            SELECT id, label, summary, tags_json FROM entities`),
        ]);
      }
      if (Number(blockCount?.count ?? 0) !== Number(blockSearchCount?.count ?? 0)) {
        await db.batch([
          db.prepare("DELETE FROM graph_block_fts"),
          db.prepare("INSERT INTO graph_block_fts(block_id, text) SELECT id, text FROM document_blocks"),
        ]);
      }
      return true;
    } catch {
      // Older or reduced SQLite environments may omit FTS5. Bound LIKE
      // queries remain a functional, injection-safe fallback.
      return false;
    }
  })();
  graphSearchReadyByDatabase.set(key, ready);
  return ready;
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
  sourceType: row.source_type === "github" ? "github" : "manual",
  sourceLabel: row.source_type === "github"
    ? `${String(row.repository_name ?? "GitHub")} · ${String(row.relative_path ?? "")}`
    : "수동 업로드",
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  error: row.error ? String(row.error) : undefined,
});

const asStoredDocument = (row: Record<string, unknown>) => {
  const document = asDocument(row);
  const sourceType = String(row.source_type);
  if (sourceType !== "manual" && sourceType !== "github") {
    throw new Error(`지원하지 않는 문서 source type입니다: ${sourceType}`);
  }
  const sourceDescriptor: DocumentSourceDescriptor = sourceType === "github"
    ? createGitHubDocumentSourceDescriptor({
      repositoryId: String(row.repository_id),
      repositoryOwner: String(row.repository_owner),
      repositoryName: String(row.repository_name),
      relativePath: String(row.relative_path),
      ref: String(row.source_ref),
      commitSha: String(row.commit_sha),
      blobSha: String(row.blob_sha),
      sourceUrl: String(row.source_url),
    })
    : createManualDocumentSourceDescriptor(document.normalizedName);
  const computedSourceKey = documentSourceKey(sourceDescriptor);
  const storedSourceKey = String(row.source_key);
  if (storedSourceKey !== computedSourceKey) {
    throw new Error(`문서 source key가 메타데이터와 일치하지 않습니다: ${document.id}`);
  }
  return {
    ...document,
    sourceType: sourceDescriptor.type,
    sourceLabel: sourceDescriptor.type === "github"
      ? `${sourceDescriptor.repositoryName} · ${sourceDescriptor.relativePath}`
      : "수동 업로드",
    source: String(row.source),
    sourceKey: computedSourceKey,
    sourceDescriptor,
  };
};

export const toPublicDocumentRecord = (
  document: StoredDocument | ReturnType<typeof asStoredDocument>,
): DocumentRecord => ({
  id: document.id,
  fileName: document.fileName,
  normalizedName: document.normalizedName,
  size: document.size,
  hash: document.hash,
  status: document.status,
  nodeCount: document.nodeCount,
  edgeCount: document.edgeCount,
  parserVersion: document.parserVersion,
  sourceType: document.sourceDescriptor.type,
  sourceLabel: document.sourceDescriptor.type === "github"
    ? `${document.sourceDescriptor.repositoryName} · ${document.sourceDescriptor.relativePath}`
    : "수동 업로드",
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  error: document.error,
});

const toGraphDocumentSummary = (document: DocumentRecord): GraphDocumentSummary => ({
  id: document.id,
  fileName: document.fileName,
  sourceType: document.sourceType,
  sourceLabel: document.sourceLabel,
  updatedAt: document.updatedAt,
  nodeCount: document.nodeCount,
  edgeCount: document.edgeCount,
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

const asRelationEvidence = (value: unknown): RelationEvidence[] | undefined => {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const evidence = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const { blockId, explanation, sourceUrl } = item as Record<string, unknown>;
      return typeof blockId === "string" && typeof explanation === "string"
        ? [{
            blockId,
            explanation,
            ...(typeof sourceUrl === "string" ? { sourceUrl } : {}),
          }]
        : [];
    });
    return evidence.length ? evidence : undefined;
  } catch {
    return undefined;
  }
};

export async function findDocumentBySourceKey(sourceKey: DocumentSourceKey) {
  const db = await database();
  if (!db) {
    return [...memoryStore().documents.values()].find((document) => document.sourceKey === sourceKey);
  }
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM documents WHERE source_key = ? LIMIT 1")
    .bind(sourceKey)
    .first<Record<string, unknown>>();
  return row ? asStoredDocument(row) : null;
}

export async function findDocumentByName(normalizedName: string) {
  return findDocumentBySourceKey(documentSourceKey({ type: "manual", normalizedName }));
}

export async function findDocumentById(id: string) {
  const db = await database();
  if (!db) return memoryStore().documents.get(id) ?? null;
  await ensureSchema(db);
  const row = await db
    .prepare("SELECT * FROM documents WHERE id = ? LIMIT 1")
    .bind(id)
    .first<Record<string, unknown>>();
  return row ? asStoredDocument(row) : null;
}

export type DocumentReprocessCandidate = {
  documentId: string;
  fileName: string;
  sourceType: DocumentSourceDescriptor["type"];
  repositoryId?: string;
  repositoryName?: string;
  relativePath?: string;
  parserVersion: string;
  blockCount: number;
};

export async function listDocumentReprocessCandidates(input: {
  documentIds?: string[];
  repositoryId?: string;
} = {}): Promise<DocumentReprocessCandidate[]> {
  const requestedIds = new Set((input.documentIds ?? []).filter(Boolean));
  const db = await database();
  if (!db) {
    return [...memoryStore().documents.values()]
      .filter((document) => !requestedIds.size || requestedIds.has(document.id))
      .filter((document) => document.sourceDescriptor.type !== "github"
        || !input.repositoryId
        || document.sourceDescriptor.repositoryId === input.repositoryId)
      .map((document) => ({
        documentId: document.id,
        fileName: document.fileName,
        sourceType: document.sourceDescriptor.type,
        repositoryId: document.sourceDescriptor.type === "github"
          ? document.sourceDescriptor.repositoryId
          : undefined,
        repositoryName: document.sourceDescriptor.type === "github"
          ? document.sourceDescriptor.repositoryName
          : undefined,
        relativePath: document.sourceDescriptor.type === "github"
          ? document.sourceDescriptor.relativePath
          : undefined,
        parserVersion: document.parserVersion,
        blockCount: document.graph.blocks.length,
      }))
      .sort((left, right) => left.documentId.localeCompare(right.documentId));
  }

  await ensureSchema(db);
  const result = input.repositoryId
    ? await db.prepare(`SELECT d.id, d.file_name, d.source_type, d.repository_id,
        d.repository_name, d.relative_path, d.parser_version, COUNT(b.id) AS block_count
        FROM documents d LEFT JOIN document_blocks b ON b.document_id = d.id
        WHERE d.repository_id = ?
        GROUP BY d.id ORDER BY d.id`).bind(input.repositoryId).all<Record<string, unknown>>()
    : await db.prepare(`SELECT d.id, d.file_name, d.source_type, d.repository_id,
        d.repository_name, d.relative_path, d.parser_version, COUNT(b.id) AS block_count
        FROM documents d LEFT JOIN document_blocks b ON b.document_id = d.id
        GROUP BY d.id ORDER BY d.id`).all<Record<string, unknown>>();
  return result.results
    .filter((row) => !requestedIds.size || requestedIds.has(String(row.id)))
    .map((row) => ({
      documentId: String(row.id),
      fileName: String(row.file_name),
      sourceType: String(row.source_type) as DocumentSourceDescriptor["type"],
      repositoryId: row.repository_id ? String(row.repository_id) : undefined,
      repositoryName: row.repository_name ? String(row.repository_name) : undefined,
      relativePath: row.relative_path ? String(row.relative_path) : undefined,
      parserVersion: String(row.parser_version),
      blockCount: Number(row.block_count ?? 0),
    }));
}

export async function saveDocument(input: {
  document: DocumentRecord;
  source: string;
  sourceDescriptor: DocumentSourceDescriptor;
  lastSeenSyncId?: string;
  graph: ExtractedGraph;
  job: IngestionJob;
}) {
  const sourceKey = documentSourceKey(input.sourceDescriptor);
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
      sourceKey,
      sourceDescriptor: input.sourceDescriptor,
      graph: input.graph,
    });
    memoryStore().jobs.set(input.job.id, input.job);
    return;
  }
  await ensureSchema(db);
  const { document, source, sourceDescriptor, graph, job } = input;
  const githubSource = sourceDescriptor.type === "github" ? sourceDescriptor : null;
  const stageId = job.id;
  const statements: D1PreparedStatement[] = [];

  graph.blocks.forEach((block: DocumentBlock) => {
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_document_blocks (stage_id, id, document_id, type, depth, text, ordinal, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(stageId, block.id, document.id, block.type, block.depth, block.text, block.ordinal, block.sourceUrl ?? null),
    );
  });
  graph.nodes.forEach((node) => {
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_entities (stage_id, id, label, short_label, kind, domain, summary, insight, tags_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(stageId, node.id, node.label, node.shortLabel, node.kind, node.domain, node.summary, node.insight, JSON.stringify(node.tags), document.updatedAt),
    );
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_entity_mentions (stage_id, id, document_id, entity_id, block_id, source_url, origin) VALUES (?, ?, ?, ?, ?, ?, 'rule')")
        .bind(
          stageId,
          entityMentionStorageId(document.id, node.id),
          document.id,
          node.id,
          graph.nodeBlockIds[node.id] ?? graph.blocks[0]?.id ?? null,
          graph.nodeEvidence?.[node.id]?.sourceUrl ?? null,
        ),
    );
  });
  graph.edges.forEach((edge) => {
    statements.push(
      db.prepare("INSERT OR REPLACE INTO staged_relations (stage_id, id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rule', 'markdown-ast', ?, NULL, ?, ?)")
        .bind(stageId, relationStorageId(document.id, edge.source, edge.target, edge.type), document.id, edge.source, edge.target, edge.type, edge.confidence, edge.note, document.parserVersion, JSON.stringify(edge.evidence ?? []), document.updatedAt),
    );
  });

  const cleanupStage = () => db.batch([
    db.prepare("DELETE FROM staged_relations WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_entities WHERE stage_id = ?").bind(stageId),
  ]);

  try {
    for (const batch of chunkD1Statements(statements)) await db.batch(batch);

    await db.batch([
      db.prepare(`INSERT INTO entities (id, label, short_label, kind, domain, summary, insight, tags_json, updated_at)
        SELECT id, label, short_label, kind, domain, summary, insight, tags_json, updated_at FROM staged_entities WHERE stage_id = ? AND 1 = 1
        ON CONFLICT(id) DO UPDATE SET label=excluded.label, short_label=excluded.short_label, kind=excluded.kind, domain=excluded.domain, summary=excluded.summary, insight=excluded.insight, tags_json=excluded.tags_json, updated_at=excluded.updated_at`)
        .bind(stageId),
      db.prepare("DELETE FROM relations WHERE document_id = ?").bind(document.id),
      db.prepare("DELETE FROM entity_mentions WHERE document_id = ?").bind(document.id),
      db.prepare("DELETE FROM document_blocks WHERE document_id = ?").bind(document.id),
      db.prepare("INSERT INTO document_blocks (id, document_id, type, depth, text, ordinal, source_url) SELECT id, document_id, type, depth, text, ordinal, source_url FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
      db.prepare("INSERT INTO entity_mentions (id, document_id, entity_id, block_id, source_url, origin) SELECT id, document_id, entity_id, block_id, source_url, origin FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
      db.prepare("INSERT INTO relations (id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at) SELECT id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at FROM staged_relations WHERE stage_id = ?").bind(stageId),
      db.prepare(`INSERT INTO documents (
          id, file_name, normalized_name, source, source_type, source_key,
          repository_id, repository_owner, repository_name, relative_path, source_ref,
          commit_sha, blob_sha, source_url, last_seen_sync_id,
          size, hash, status, node_count, edge_count, parser_version, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          file_name=excluded.file_name, normalized_name=excluded.normalized_name, source=excluded.source,
          source_type=excluded.source_type, source_key=excluded.source_key,
          repository_id=excluded.repository_id, repository_owner=excluded.repository_owner,
          repository_name=excluded.repository_name, relative_path=excluded.relative_path,
          source_ref=excluded.source_ref, commit_sha=excluded.commit_sha, blob_sha=excluded.blob_sha,
          source_url=excluded.source_url, last_seen_sync_id=excluded.last_seen_sync_id,
          size=excluded.size, hash=excluded.hash, status=excluded.status,
          node_count=excluded.node_count, edge_count=excluded.edge_count,
          parser_version=excluded.parser_version, error=excluded.error, updated_at=excluded.updated_at`)
        .bind(
          document.id,
          document.fileName,
          document.normalizedName,
          source,
          sourceDescriptor.type,
          sourceKey,
          githubSource?.repositoryId ?? null,
          githubSource?.repositoryOwner ?? null,
          githubSource?.repositoryName ?? null,
          githubSource?.relativePath ?? null,
          githubSource?.ref ?? null,
          githubSource?.commitSha ?? null,
          githubSource?.blobSha ?? null,
          githubSource?.sourceUrl ?? null,
          input.lastSeenSyncId ?? null,
          document.size,
          document.hash,
          document.status,
          document.nodeCount,
          document.edgeCount,
          document.parserVersion,
          document.error ?? null,
          document.createdAt,
          document.updatedAt,
        ),
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

export type GitHubRepositoryPreparedDocument = {
  document: DocumentRecord;
  source: string;
  sourceDescriptor: Extract<DocumentSourceDescriptor, { type: "github" }>;
  graph: ExtractedGraph;
  job: IngestionJob;
};

export type GitHubRepositoryUnchangedDocument = {
  sourceDescriptor: Extract<DocumentSourceDescriptor, { type: "github" }>;
};

export type GitHubRepositoryDocumentState = {
  id: string;
  sourceKey: DocumentSourceKey;
  sourceDescriptor: Extract<DocumentSourceDescriptor, { type: "github" }>;
  hash: string;
  parserVersion: string;
  size: number;
  nodeCount: number;
  edgeCount: number;
};

export async function listGitHubRepositoryDocuments(
  repositoryId: string,
): Promise<GitHubRepositoryDocumentState[]> {
  const db = await database();
  if (!db) {
    return [...memoryStore().documents.values()].flatMap((document) => {
      const sourceDescriptor = document.sourceDescriptor;
      if (sourceDescriptor.type !== "github" || sourceDescriptor.repositoryId !== repositoryId) return [];
      return [{
        id: document.id,
        sourceKey: document.sourceKey,
        sourceDescriptor,
        hash: document.hash,
        parserVersion: document.parserVersion,
        size: document.size,
        nodeCount: document.nodeCount,
        edgeCount: document.edgeCount,
      }];
    });
  }
  await ensureSchema(db);
  const result = await db.prepare(
    "SELECT * FROM documents WHERE source_type = 'github' AND repository_id = ? ORDER BY relative_path",
  ).bind(repositoryId).all<Record<string, unknown>>();
  return result.results.map((row) => {
    const document = asStoredDocument(row);
    if (document.sourceDescriptor.type !== "github") throw new Error("GitHub 문서 상태가 잘못되었습니다.");
    return {
      id: document.id,
      sourceKey: document.sourceKey,
      sourceDescriptor: document.sourceDescriptor,
      hash: document.hash,
      parserVersion: document.parserVersion,
      size: document.size,
      nodeCount: document.nodeCount,
      edgeCount: document.edgeCount,
    };
  });
}

export async function findGitHubApplyReceipt(syncId: string): Promise<GitHubApplyReceipt | null> {
  const db = await database();
  if (!db) return memoryStore().githubApplyReceipts.get(syncId) ?? null;
  await ensureSchema(db);
  const row = await db.prepare(
    "SELECT receipt_json FROM github_sync_runs WHERE id = ? AND kind = 'apply' AND status = 'completed' LIMIT 1",
  ).bind(syncId).first<{ receipt_json?: unknown }>();
  if (!row?.receipt_json) return null;
  try {
    return parseGitHubApplyReceipt(JSON.parse(String(row.receipt_json)));
  } catch {
    throw new Error("저장된 GitHub apply 영수증이 손상되었습니다.");
  }
}

export async function replaceGitHubRepositoryDocuments(input: {
  repositoryId: string;
  syncId: string;
  documents: GitHubRepositoryPreparedDocument[];
  unchangedDocuments?: GitHubRepositoryUnchangedDocument[];
  receipt: {
    repositoryName: string;
    commitSha: string;
    manifestDigest: string;
    appliedAt: string;
  };
}): Promise<GitHubApplyReceipt> {
  const unchangedDocuments = input.unchangedDocuments ?? [];
  const sourceKeys = new Set<string>();
  for (const sourceDescriptor of [
    ...input.documents.map((item) => item.sourceDescriptor),
    ...unchangedDocuments.map((item) => item.sourceDescriptor),
  ]) {
    if (sourceDescriptor.repositoryId !== input.repositoryId) {
      throw new Error("저장소 apply 문서의 repositoryId가 일치하지 않습니다.");
    }
    const sourceKey = documentSourceKey(sourceDescriptor);
    if (sourceKeys.has(sourceKey)) throw new Error(`저장소 apply 문서가 중복되었습니다: ${sourceKey}`);
    sourceKeys.add(sourceKey);
  }

  const db = await database();
  if (!db) {
    const store = memoryStore();
    const existing = [...store.documents.values()].filter((document) =>
      document.sourceDescriptor.type === "github"
      && document.sourceDescriptor.repositoryId === input.repositoryId,
    );
    const existingBySource = new Map(existing.map((document) => [document.sourceKey, document]));
    for (const item of unchangedDocuments) {
      const sourceKey = documentSourceKey(item.sourceDescriptor);
      const current = existingBySource.get(sourceKey);
      if (
        !current
        || current.sourceDescriptor.type !== "github"
        || current.sourceDescriptor.blobSha !== item.sourceDescriptor.blobSha
      ) throw new Error(`unchanged 문서 상태가 apply 준비 이후 변경되었습니다: ${sourceKey}`);
    }
    const createdCount = input.documents.filter((item) =>
      !existingBySource.has(documentSourceKey(item.sourceDescriptor))).length;
    const unchangedCount = unchangedDocuments.length;
    const updatedCount = input.documents.length - createdCount;
    const deletedCount = existing.filter((document) => !sourceKeys.has(document.sourceKey)).length;
    const receipt: GitHubApplyReceipt = {
      repositoryId: input.repositoryId,
      repositoryName: input.receipt.repositoryName,
      commitSha: input.receipt.commitSha,
      manifestDigest: input.receipt.manifestDigest,
      fileCount: sourceKeys.size,
      createdCount,
      updatedCount,
      unchangedCount,
      deletedCount,
      nodeCount: input.documents.reduce((sum, item) => sum + item.document.nodeCount, 0)
        + unchangedDocuments.reduce((sum, item) =>
          sum + (existingBySource.get(documentSourceKey(item.sourceDescriptor))?.nodeCount ?? 0), 0),
      edgeCount: input.documents.reduce((sum, item) => sum + item.document.edgeCount, 0)
        + unchangedDocuments.reduce((sum, item) =>
          sum + (existingBySource.get(documentSourceKey(item.sourceDescriptor))?.edgeCount ?? 0), 0),
      appliedAt: input.receipt.appliedAt,
    };
    if (
      process.env.ATLAS_TEST_MODE === "true"
      && process.env.ATLAS_TEST_FAIL_REPOSITORY_APPLY === input.repositoryId
    ) throw new Error("테스트용 저장소 apply 실패");

    const nextDocuments = new Map(store.documents);
    const nextJobs = new Map(store.jobs);
    const affectedDocumentIds = new Set(existing
      .filter((document) =>
        !sourceKeys.has(document.sourceKey)
        || input.documents.some((item) => documentSourceKey(item.sourceDescriptor) === document.sourceKey))
      .map((document) => document.id));
    for (const documentId of affectedDocumentIds) nextDocuments.delete(documentId);
    for (const [jobId, job] of nextJobs) {
      if (affectedDocumentIds.has(job.documentId)) nextJobs.delete(jobId);
    }
    for (const item of input.documents) {
      nextDocuments.set(item.document.id, {
        ...item.document,
        source: item.source,
        sourceKey: documentSourceKey(item.sourceDescriptor),
        sourceDescriptor: item.sourceDescriptor,
        graph: item.graph,
      });
      nextJobs.set(item.job.id, item.job);
    }
    for (const item of unchangedDocuments) {
      const sourceKey = documentSourceKey(item.sourceDescriptor);
      const current = existingBySource.get(sourceKey)!;
      nextDocuments.set(current.id, { ...current, sourceDescriptor: item.sourceDescriptor });
    }
    store.documents = nextDocuments;
    store.jobs = nextJobs;
    store.githubApplyReceipts.set(input.syncId, receipt);
    return receipt;
  }

  await ensureSchema(db);
  const existingResult = await db.prepare(
    "SELECT id, source_key, hash, blob_sha, node_count, edge_count FROM documents WHERE source_type = 'github' AND repository_id = ?",
  ).bind(input.repositoryId).all<Record<string, unknown>>();
  const existingBySource = new Map(existingResult.results.map((row) => [String(row.source_key), row]));
  for (const item of unchangedDocuments) {
    const sourceKey = documentSourceKey(item.sourceDescriptor);
    const current = existingBySource.get(sourceKey);
    if (!current || String(current.blob_sha) !== item.sourceDescriptor.blobSha) {
      throw new Error(`unchanged 문서 상태가 apply 준비 이후 변경되었습니다: ${sourceKey}`);
    }
  }
  const createdCount = input.documents.filter((item) =>
    !existingBySource.has(documentSourceKey(item.sourceDescriptor))).length;
  const unchangedCount = unchangedDocuments.length;
  const updatedCount = input.documents.length - createdCount;
  const deletedCount = existingResult.results.filter((row) => !sourceKeys.has(String(row.source_key))).length;
  const receipt: GitHubApplyReceipt = {
    repositoryId: input.repositoryId,
    repositoryName: input.receipt.repositoryName,
    commitSha: input.receipt.commitSha,
    manifestDigest: input.receipt.manifestDigest,
    fileCount: sourceKeys.size,
    createdCount,
    updatedCount,
    unchangedCount,
    deletedCount,
    nodeCount: input.documents.reduce((sum, item) => sum + item.document.nodeCount, 0)
      + unchangedDocuments.reduce((sum, item) =>
        sum + Number(existingBySource.get(documentSourceKey(item.sourceDescriptor))?.node_count ?? 0), 0),
    edgeCount: input.documents.reduce((sum, item) => sum + item.document.edgeCount, 0)
      + unchangedDocuments.reduce((sum, item) =>
        sum + Number(existingBySource.get(documentSourceKey(item.sourceDescriptor))?.edge_count ?? 0), 0),
    appliedAt: input.receipt.appliedAt,
  };
  const stageId = input.syncId;
  const stageStatements: D1PreparedStatement[] = [];
  for (const { document, source, sourceDescriptor, graph, job } of input.documents) {
    stageStatements.push(
      db.prepare(`INSERT OR REPLACE INTO staged_documents (
        stage_id, id, file_name, normalized_name, source, source_type, source_key,
        repository_id, repository_owner, repository_name, relative_path, source_ref,
        commit_sha, blob_sha, source_url, last_seen_sync_id, size, hash, status,
        node_count, edge_count, parser_version, error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          stageId, document.id, document.fileName, document.normalizedName, source,
          documentSourceKey(sourceDescriptor), sourceDescriptor.repositoryId,
          sourceDescriptor.repositoryOwner, sourceDescriptor.repositoryName,
          sourceDescriptor.relativePath, sourceDescriptor.ref, sourceDescriptor.commitSha,
          sourceDescriptor.blobSha, sourceDescriptor.sourceUrl, input.syncId,
          document.size, document.hash, document.status, document.nodeCount,
          document.edgeCount, document.parserVersion, document.error ?? null,
          document.createdAt, document.updatedAt,
        ),
      db.prepare(`INSERT OR REPLACE INTO staged_ingestion_jobs
        (stage_id, id, document_id, file_name, status, progress, message, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(stageId, job.id, job.documentId, job.fileName, job.status, job.progress, job.message, job.createdAt, job.completedAt ?? null),
      db.prepare(`INSERT OR REPLACE INTO staged_github_document_targets
        (stage_id, source_key, mode, repository_owner, repository_name, relative_path,
         source_ref, commit_sha, blob_sha, source_url)
        VALUES (?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          stageId, documentSourceKey(sourceDescriptor), sourceDescriptor.repositoryOwner,
          sourceDescriptor.repositoryName, sourceDescriptor.relativePath, sourceDescriptor.ref,
          sourceDescriptor.commitSha, sourceDescriptor.blobSha, sourceDescriptor.sourceUrl,
        ),
    );
    for (const block of graph.blocks) {
      stageStatements.push(
        db.prepare("INSERT OR REPLACE INTO staged_document_blocks (stage_id, id, document_id, type, depth, text, ordinal, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(stageId, block.id, document.id, block.type, block.depth, block.text, block.ordinal, block.sourceUrl ?? null),
      );
    }
    for (const node of graph.nodes) {
      stageStatements.push(
        db.prepare("INSERT OR REPLACE INTO staged_entities (stage_id, id, label, short_label, kind, domain, summary, insight, tags_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(stageId, node.id, node.label, node.shortLabel, node.kind, node.domain, node.summary, node.insight, JSON.stringify(node.tags), document.updatedAt),
        db.prepare("INSERT OR REPLACE INTO staged_entity_mentions (stage_id, id, document_id, entity_id, block_id, source_url, origin) VALUES (?, ?, ?, ?, ?, ?, 'rule')")
          .bind(
            stageId,
            entityMentionStorageId(document.id, node.id),
            document.id,
            node.id,
            graph.nodeBlockIds[node.id] ?? graph.blocks[0]?.id ?? null,
            graph.nodeEvidence?.[node.id]?.sourceUrl ?? null,
          ),
      );
    }
    for (const edge of graph.edges) {
      stageStatements.push(
        db.prepare("INSERT OR REPLACE INTO staged_relations (stage_id, id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rule', 'markdown-ast', ?, NULL, ?, ?)")
          .bind(stageId, relationStorageId(document.id, edge.source, edge.target, edge.type), document.id, edge.source, edge.target, edge.type, edge.confidence, edge.note, document.parserVersion, JSON.stringify(edge.evidence ?? []), document.updatedAt),
      );
    }
  }
  for (const { sourceDescriptor } of unchangedDocuments) {
    stageStatements.push(
      db.prepare(`INSERT OR REPLACE INTO staged_github_document_targets
        (stage_id, source_key, mode, repository_owner, repository_name, relative_path,
         source_ref, commit_sha, blob_sha, source_url)
        VALUES (?, ?, 'unchanged', ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          stageId, documentSourceKey(sourceDescriptor), sourceDescriptor.repositoryOwner,
          sourceDescriptor.repositoryName, sourceDescriptor.relativePath, sourceDescriptor.ref,
          sourceDescriptor.commitSha, sourceDescriptor.blobSha, sourceDescriptor.sourceUrl,
        ),
    );
  }
  const cleanupStage = () => db.batch([
    db.prepare("DELETE FROM staged_relations WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_entities WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_ingestion_jobs WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_documents WHERE stage_id = ?").bind(stageId),
    db.prepare("DELETE FROM staged_github_document_targets WHERE stage_id = ?").bind(stageId),
  ]);

  try {
    await cleanupStage();
    for (const batch of chunkD1Statements(stageStatements)) await db.batch(batch);
    const commit: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO entities (id, label, short_label, kind, domain, summary, insight, tags_json, updated_at)
        SELECT id, label, short_label, kind, domain, summary, insight, tags_json, updated_at FROM staged_entities WHERE stage_id = ?
        ON CONFLICT(id) DO UPDATE SET label=excluded.label, short_label=excluded.short_label, kind=excluded.kind, domain=excluded.domain, summary=excluded.summary, insight=excluded.insight, tags_json=excluded.tags_json, updated_at=excluded.updated_at`).bind(stageId),
    ];
    const affectedDocumentIds = `SELECT id FROM documents
      WHERE source_type = 'github' AND repository_id = ? AND (
        source_key NOT IN (SELECT source_key FROM staged_github_document_targets WHERE stage_id = ?)
        OR source_key IN (SELECT source_key FROM staged_github_document_targets WHERE stage_id = ? AND mode = 'prepared')
      )`;
    commit.push(
      db.prepare(`DELETE FROM relations WHERE document_id IN (${affectedDocumentIds})`).bind(input.repositoryId, stageId, stageId),
      db.prepare(`DELETE FROM entity_mentions WHERE document_id IN (${affectedDocumentIds})`).bind(input.repositoryId, stageId, stageId),
      db.prepare(`DELETE FROM document_blocks WHERE document_id IN (${affectedDocumentIds})`).bind(input.repositoryId, stageId, stageId),
      db.prepare(`DELETE FROM ingestion_jobs WHERE document_id IN (${affectedDocumentIds})`).bind(input.repositoryId, stageId, stageId),
      db.prepare(`DELETE FROM enrichment_jobs WHERE document_id IN (${affectedDocumentIds})`).bind(input.repositoryId, stageId, stageId),
      db.prepare(`DELETE FROM documents WHERE id IN (${affectedDocumentIds})`).bind(input.repositoryId, stageId, stageId),
    );
    commit.push(
      db.prepare("INSERT INTO document_blocks (id, document_id, type, depth, text, ordinal, source_url) SELECT id, document_id, type, depth, text, ordinal, source_url FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
      db.prepare("INSERT INTO entity_mentions (id, document_id, entity_id, block_id, source_url, origin) SELECT id, document_id, entity_id, block_id, source_url, origin FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
      db.prepare("INSERT INTO relations (id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at) SELECT id, document_id, source_id, target_id, type, confidence, note, origin, provider, provider_version, prompt_version, evidence_json, created_at FROM staged_relations WHERE stage_id = ?").bind(stageId),
      db.prepare(`INSERT INTO documents (
        id, file_name, normalized_name, source, source_type, source_key,
        repository_id, repository_owner, repository_name, relative_path, source_ref,
        commit_sha, blob_sha, source_url, last_seen_sync_id,
        size, hash, status, node_count, edge_count, parser_version, error, created_at, updated_at
      ) SELECT id, file_name, normalized_name, source, source_type, source_key,
        repository_id, repository_owner, repository_name, relative_path, source_ref,
        commit_sha, blob_sha, source_url, last_seen_sync_id,
        size, hash, status, node_count, edge_count, parser_version, error, created_at, updated_at
        FROM staged_documents WHERE stage_id = ?`).bind(stageId),
      db.prepare(`INSERT INTO ingestion_jobs
        (id, document_id, file_name, status, progress, message, created_at, completed_at)
        SELECT id, document_id, file_name, status, progress, message, created_at, completed_at
        FROM staged_ingestion_jobs WHERE stage_id = ?`).bind(stageId),
      db.prepare(`UPDATE documents SET
        (repository_owner, repository_name, relative_path, source_ref, commit_sha, blob_sha, source_url, last_seen_sync_id) = (
          SELECT repository_owner, repository_name, relative_path, source_ref, commit_sha, blob_sha, source_url, ?
          FROM staged_github_document_targets target
          WHERE target.stage_id = ? AND target.source_key = documents.source_key
        )
        WHERE source_type = 'github' AND repository_id = ? AND source_key IN (
          SELECT source_key FROM staged_github_document_targets WHERE stage_id = ? AND mode = 'unchanged'
        )`).bind(input.syncId, stageId, input.repositoryId, stageId),
    );
    commit.push(
      db.prepare(`INSERT OR REPLACE INTO github_sync_runs (
        id, kind, status, manifest_digest, discovered_count, selected_count,
        changed_count, unchanged_count, deleted_count, failed_count, receipt_json,
        created_at, updated_at, started_at, completed_at
      ) VALUES (?, 'apply', 'completed', ?, 1, 1, ?, ?, ?, 0, ?, ?, ?, ?, ?)`)
        .bind(
          input.syncId,
          receipt.manifestDigest,
          receipt.createdCount + receipt.updatedCount,
          receipt.unchangedCount,
          receipt.deletedCount,
          JSON.stringify(receipt),
          receipt.appliedAt,
          receipt.appliedAt,
          receipt.appliedAt,
          receipt.appliedAt,
        ),
      db.prepare("DELETE FROM staged_relations WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_entity_mentions WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_document_blocks WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_entities WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_ingestion_jobs WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_documents WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM staged_github_document_targets WHERE stage_id = ?").bind(stageId),
      db.prepare("DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)"),
    );
    assertD1AtomicBatchLimit(commit, "GitHub 저장소 Graph commit");
    await db.batch(commit);
  } catch (error) {
    await cleanupStage().catch(() => undefined);
    throw error;
  }
  return receipt;
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
    documents = [...memoryStore().documents.values()].map(toPublicDocumentRecord);
    jobs = [...memoryStore().jobs.values()];
  } else {
    await ensureSchema(db);
    const [documentResult, jobResult] = await Promise.all([
      db.prepare("SELECT * FROM documents ORDER BY updated_at DESC").all<Record<string, unknown>>(),
      db.prepare("SELECT * FROM ingestion_jobs ORDER BY created_at DESC LIMIT 20").all<Record<string, unknown>>(),
    ]);
    documents = documentResult.results.map(asStoredDocument).map(toPublicDocumentRecord);
    jobs = jobResult.results.map(asJob);
  }
  const enrichmentRepository = await getEnrichmentJobRepository();
  const [enrichmentRecords, heartbeats, enrichmentCounts, integratedEnrichmentCounts] = await Promise.all([
    enrichmentRepository.list(undefined, 50),
    enrichmentRepository.listRuntimeStatuses(),
    enrichmentRepository.statusCounts(),
    enrichmentRepository.statusCounts(INTEGRATED_CODEX_PROVIDER_VERSION),
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
      ontologyVersion: job.input.ontologyVersion,
      chunkIndex: job.input.chunk ? job.input.chunk.index + 1 : undefined,
      chunkCount: job.input.chunk?.count,
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
  const queuedJobs = integratedEnrichmentCounts.queued;
  const activeJobs = integratedEnrichmentCounts.leased + integratedEnrichmentCounts.running;
  const revisionRows = db ? await graphRevisionRows(db) : null;
  const graphRevision = revisionRows
    ? graphRevisionFromRows(revisionRows)
    : memoryGraphRevision();
  const memoryNodes = !db
    ? new Set([...memoryStore().documents.values()].flatMap((document) => document.graph.nodes.map((node) => node.id))).size
    : 0;
  const memoryEdges = !db
    ? new Set([...memoryStore().documents.values()].flatMap((document) => document.graph.edges.map((edge) => `${edge.source}|${edge.target}|${edge.type}`))).size
    : 0;
  return {
    documents: [...documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    jobs: recentJobs,
    enrichmentJobs,
    runtime: {
      status: onlineHeartbeats.length ? "online" : "offline",
      onlineCount: onlineHeartbeats.length,
      queuedJobs,
      activeJobs,
      lastSeenAt: latestHeartbeat?.lastSeenAt,
      currentJobId: onlineHeartbeats.find((heartbeat) => heartbeat.currentJobId)?.currentJobId,
      runMode: latestHeartbeat?.runMode,
      maxJobs: latestHeartbeat?.maxJobs,
      maxRuntimeMs: latestHeartbeat?.maxRuntimeMs,
      processedJobs: latestHeartbeat?.processedJobs,
      succeededJobs: latestHeartbeat?.succeededJobs,
      warningJobs: latestHeartbeat?.warningJobs,
      failedJobs: latestHeartbeat?.failedJobs,
      stopReason: latestHeartbeat?.stopReason,
    },
    totals: {
      documents: documents.length,
      nodes: documents.reduce((sum, document) => sum + document.nodeCount, 0),
      edges: documents.reduce((sum, document) => sum + document.edgeCount, 0),
      processing: documents.filter((document) => ["queued", "validating", "parsing"].includes(document.status)).length,
      failed: documents.filter((document) => document.status === "failed").length,
      enrichmentQueued: queuedJobs,
      enrichmentActive: activeJobs,
      enrichmentWarnings: integratedEnrichmentCounts.warning + integratedEnrichmentCounts.failed,
      legacyEnrichmentQueued: Math.max(0, enrichmentCounts.queued - queuedJobs),
      storedNodes: revisionRows ? Number(revisionRows.entityResult?.count ?? 0) : memoryNodes,
      storedEdges: revisionRows ? Number(revisionRows.relationResult?.count ?? 0) : memoryEdges,
      projectionNodeLimit: GRAPH_CORPUS_NODE_BUDGET,
      projectionEdgeLimit: GRAPH_CORPUS_EDGE_BUDGET,
    },
    storage: db ? "d1" : "memory",
    graphRevision,
  };
}

export async function getGitHubRepositoryStorageSummaries(): Promise<GitHubRepositoryStorageSummary[]> {
  const summaries = new Map<string, GitHubRepositoryStorageSummary>();
  const applyReceipt = (receipt: GitHubApplyReceipt) => {
    const current = summaries.get(receipt.repositoryId);
    if (current && current.lastSyncedAt > receipt.appliedAt) return;
    summaries.set(receipt.repositoryId, {
      repositoryId: receipt.repositoryId,
      repositoryOwner: current?.repositoryOwner ?? "coreline-ai",
      repositoryName: receipt.repositoryName,
      documentCount: receipt.fileCount,
      nodeCount: receipt.nodeCount,
      edgeCount: receipt.edgeCount,
      commitSha: receipt.commitSha,
      manifestDigest: receipt.manifestDigest,
      lastSyncedAt: receipt.appliedAt,
    });
  };

  const db = await database();
  if (!db) {
    for (const document of memoryStore().documents.values()) {
      if (document.sourceDescriptor.type !== "github") continue;
      const source = document.sourceDescriptor;
      const current = summaries.get(source.repositoryId);
      summaries.set(source.repositoryId, {
        repositoryId: source.repositoryId,
        repositoryOwner: source.repositoryOwner,
        repositoryName: source.repositoryName,
        documentCount: (current?.documentCount ?? 0) + 1,
        nodeCount: (current?.nodeCount ?? 0) + document.nodeCount,
        edgeCount: (current?.edgeCount ?? 0) + document.edgeCount,
        commitSha: document.updatedAt >= (current?.lastSyncedAt ?? "")
          ? source.commitSha
          : current?.commitSha,
        lastSyncedAt: current && current.lastSyncedAt > document.updatedAt
          ? current.lastSyncedAt
          : document.updatedAt,
      });
    }
    for (const receipt of memoryStore().githubApplyReceipts.values()) applyReceipt(receipt);
  } else {
    await ensureSchema(db);
    const [documentResult, receiptResult] = await Promise.all([
      db.prepare(`SELECT repository_id, repository_owner, repository_name, commit_sha,
        node_count, edge_count, updated_at FROM documents
        WHERE source_type = 'github' AND repository_id IS NOT NULL
        ORDER BY repository_id, updated_at`).all<Record<string, unknown>>(),
      db.prepare(`SELECT receipt_json FROM github_sync_runs
        WHERE kind = 'apply' AND status = 'completed' AND receipt_json IS NOT NULL
        ORDER BY completed_at`).all<Record<string, unknown>>(),
    ]);
    for (const row of documentResult.results) {
      const repositoryId = String(row.repository_id);
      const updatedAt = String(row.updated_at);
      const current = summaries.get(repositoryId);
      summaries.set(repositoryId, {
        repositoryId,
        repositoryOwner: String(row.repository_owner ?? current?.repositoryOwner ?? "coreline-ai"),
        repositoryName: String(row.repository_name ?? current?.repositoryName ?? repositoryId),
        documentCount: (current?.documentCount ?? 0) + 1,
        nodeCount: (current?.nodeCount ?? 0) + Number(row.node_count ?? 0),
        edgeCount: (current?.edgeCount ?? 0) + Number(row.edge_count ?? 0),
        commitSha: updatedAt >= (current?.lastSyncedAt ?? "")
          ? String(row.commit_sha ?? "") || undefined
          : current?.commitSha,
        lastSyncedAt: current && current.lastSyncedAt > updatedAt
          ? current.lastSyncedAt
          : updatedAt,
      });
    }
    for (const row of receiptResult.results) {
      try {
        applyReceipt(parseGitHubApplyReceipt(JSON.parse(String(row.receipt_json))));
      } catch {
        // 손상된 과거 영수증 하나가 나머지 저장소 상태 조회를 막지 않게 격리한다.
      }
    }
  }

  return [...summaries.values()].sort((left, right) =>
    right.lastSyncedAt.localeCompare(left.lastSyncedAt)
    || left.repositoryName.localeCompare(right.repositoryName)
    || left.repositoryId.localeCompare(right.repositoryId));
}

export async function getGraphSnapshot(): Promise<GraphSnapshot> {
  const db = await database();
  if (db) await ensureSchema(db);
  const graphRevision = db
    ? graphRevisionFromRows(await graphRevisionRows(db))
    : memoryGraphRevision();
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
    const [documentResult, nodeResult, edgeResult] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM documents WHERE status IN ('completed', 'unchanged')").first<{ count: number }>(),
      db.prepare("SELECT DISTINCT e.* FROM entities e INNER JOIN entity_mentions m ON m.entity_id = e.id").all<Record<string, unknown>>(),
      db.prepare("SELECT DISTINCT source_id, target_id, type, confidence, note, evidence_json, origin, provider FROM relations").all<Record<string, unknown>>(),
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
      evidence: asRelationEvidence(row.evidence_json),
      layer: row.origin === "codex"
        ? "inferred"
        : ["documents", "plans", "contains"].includes(String(row.type))
          ? "structural"
          : "explicit",
      origin: row.origin === "codex" ? "codex" : "rule",
      provider: row.provider ? String(row.provider) : undefined,
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
        graphRevision,
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
      graphRevision,
    },
  };
}

const knowledgeNodeFromRow = (row: Record<string, unknown>): KnowledgeNode => ({
  id: String(row.id),
  label: String(row.label),
  shortLabel: String(row.short_label),
  kind: String(row.kind) as KnowledgeNode["kind"],
  domain: String(row.domain) as KnowledgeNode["domain"],
  summary: String(row.summary),
  insight: String(row.insight),
  tags: JSON.parse(String(row.tags_json)) as string[],
});

const knowledgeEdgeFromRow = (row: Record<string, unknown>): KnowledgeEdge => ({
  source: String(row.source_id),
  target: String(row.target_id),
  type: String(row.type) as KnowledgeEdge["type"],
  confidence: Number(row.confidence),
  note: String(row.note),
  evidence: asRelationEvidence(row.evidence_json),
  layer: row.origin === "codex"
    ? "inferred"
    : ["documents", "plans", "contains"].includes(String(row.type))
      ? "structural"
      : "explicit",
  origin: row.origin === "codex" ? "codex" : "rule",
  provider: row.provider ? String(row.provider) : undefined,
});

const graphQueryLikePattern = (term: string) =>
  `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

const graphQueryClause = (terms: readonly string[], columns: readonly string[]) => ({
  sql: terms.map(() => `(${columns.map((column) => `LOWER(${column}) LIKE ? ESCAPE '\\'`).join(" OR ")})`).join(" OR "),
  bindings: terms.flatMap((term) => columns.map(() => graphQueryLikePattern(term))),
});

const graphFtsQuery = (terms: readonly string[]) => terms
  .map((term) => `"${term.replace(/"/g, '""')}"*`)
  .join(" OR ");

const safeGraphCitationUrl = (value: unknown) => {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

const graphCitationFromRows = (
  rows: readonly Record<string, unknown>[],
  endpointIds = new Map<string, Set<string>>(),
) => {
  const citations = new Map<string, GraphRetrievalCitation>();
  for (const row of rows) {
    const id = String(row.block_id ?? "");
    if (!id) continue;
    const existing = citations.get(id);
    const nodeIds = new Set(existing?.nodeIds ?? endpointIds.get(id) ?? []);
    if (row.entity_id) nodeIds.add(String(row.entity_id));
    citations.set(id, {
      id,
      documentId: row.document_id ? String(row.document_id) : undefined,
      fileName: row.file_name ? String(row.file_name) : undefined,
      repositoryOwner: row.repository_owner ? String(row.repository_owner) : undefined,
      repositoryName: row.repository_name ? String(row.repository_name) : undefined,
      relativePath: row.relative_path ? String(row.relative_path) : undefined,
      text: String(row.block_text ?? row.explanation ?? "문서 근거").slice(0, 800),
      sourceUrl: safeGraphCitationUrl(row.source_url),
      nodeIds: [...nodeIds].sort(),
    });
  }
  return [...citations.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const graphRelationQuery = async (db: D1Database, nodeIds: readonly string[], limit: number) => {
  if (!nodeIds.length) return [] as KnowledgeEdge[];
  const placeholders = nodeIds.map(() => "?").join(",");
  const result = await db.prepare(`SELECT DISTINCT source_id, target_id, type, confidence, note,
      evidence_json, origin, provider
    FROM relations
    WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
    ORDER BY confidence DESC, source_id, target_id, type
    LIMIT ?`)
    .bind(...nodeIds, ...nodeIds, limit)
    .all<Record<string, unknown>>();
  return result.results.map(knowledgeEdgeFromRow);
};

const graphRelationQueryChunked = async (
  db: D1Database,
  nodeIds: readonly string[],
  limit: number,
) => {
  const uniqueIds = [...new Set(nodeIds)];
  const edgeMap = new Map<string, KnowledgeEdge>();
  // D1 counts both source and target bindings. Forty IDs keep the query at
  // 81 variables (40 + 40 + LIMIT), below the 100-variable local/remote cap.
  for (let index = 0; index < uniqueIds.length && edgeMap.size < limit; index += 40) {
    const chunk = uniqueIds.slice(index, index + 40);
    const edges = await graphRelationQuery(db, chunk, Math.min(limit, 2_400));
    for (const edge of edges) {
      edgeMap.set(`${edge.source}|${edge.target}|${edge.type}`, edge);
    }
  }
  return [...edgeMap.values()]
    .sort((left, right) => right.confidence - left.confidence
      || `${left.source}|${left.target}|${left.type}`
        .localeCompare(`${right.source}|${right.target}|${right.type}`))
    .slice(0, limit);
};

const loadGraphNodesById = async (db: D1Database, nodeIds: readonly string[]) => {
  const uniqueIds = [...new Set(nodeIds)];
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < uniqueIds.length; index += 80) {
    const chunk = uniqueIds.slice(index, index + 80);
    const result = await db.prepare(`SELECT * FROM entities WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<Record<string, unknown>>();
    rows.push(...result.results);
  }
  return rows.map(knowledgeNodeFromRow);
};

/**
 * Builds a bounded retrieval slice instead of materializing the 90k-node
 * corpus. SQL values remain bound parameters and LIKE wildcard characters are
 * escaped before the graph neighborhood is expanded to at most two hops.
 */
export async function getGraphRetrievalSource(
  query: NormalizedGraphQuestion,
): Promise<GraphRetrievalSource> {
  const db = await database();
  if (!db) {
    const snapshot = await getGraphSnapshot();
    const citationRows = snapshot.edges.flatMap((edge) => (edge.evidence ?? []).map((evidence) => ({
      block_id: evidence.blockId,
      explanation: evidence.explanation,
      source_url: evidence.sourceUrl,
      entity_id: edge.source,
    })).concat((edge.evidence ?? []).map((evidence) => ({
      block_id: evidence.blockId,
      explanation: evidence.explanation,
      source_url: evidence.sourceUrl,
      entity_id: edge.target,
    }))));
    return {
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      citations: graphCitationFromRows(citationRows),
    };
  }

  await ensureSchema(db);
  const graphFtsAvailable = await ensureGraphSearchSchema(db);
  const entityMatch = graphQueryClause(query.terms, [
    "entity.label",
    "entity.short_label",
    "entity.summary",
    "entity.insight",
    "entity.tags_json",
  ]);
  const blockMatch = graphQueryClause(query.terms, ["block.text"]);
  const ftsQuery = graphFtsQuery(query.terms);
  const [entityResult, blockResult] = await Promise.all([
    graphFtsAvailable
      ? db.prepare(`WITH matches AS (
          SELECT entity_id, bm25(graph_entity_fts) AS search_rank
          FROM graph_entity_fts
          WHERE graph_entity_fts MATCH ?
          ORDER BY search_rank, entity_id
          LIMIT 80
        )
        SELECT entity.*, matches.search_rank
        FROM matches INNER JOIN entities entity ON entity.id = matches.entity_id
        ORDER BY matches.search_rank, entity.id`).bind(ftsQuery).all<Record<string, unknown>>()
      : db.prepare(`SELECT entity.* FROM entities entity
          WHERE ${entityMatch.sql}
          ORDER BY entity.id
          LIMIT 80`).bind(...entityMatch.bindings).all<Record<string, unknown>>(),
    graphFtsAvailable
      ? db.prepare(`WITH matches AS (
          SELECT block_id, bm25(graph_block_fts) AS search_rank
          FROM graph_block_fts
          WHERE graph_block_fts MATCH ?
          ORDER BY search_rank, block_id
          LIMIT 48
        )
        SELECT block.id AS block_id, block.document_id, block.text AS block_text,
          COALESCE(mention.source_url, block.source_url, document.source_url) AS source_url,
          mention.entity_id, document.file_name, document.repository_owner,
          document.repository_name, document.relative_path, matches.search_rank
        FROM matches
        INNER JOIN document_blocks block ON block.id = matches.block_id
        INNER JOIN documents document ON document.id = block.document_id
        LEFT JOIN entity_mentions mention ON mention.block_id = block.id
        WHERE document.status IN ('completed', 'unchanged')
        ORDER BY matches.search_rank, block.document_id, block.ordinal, mention.entity_id
        LIMIT 120`).bind(ftsQuery).all<Record<string, unknown>>()
      : db.prepare(`SELECT block.id AS block_id, block.document_id, block.text AS block_text,
          COALESCE(mention.source_url, block.source_url, document.source_url) AS source_url,
          mention.entity_id, document.file_name, document.repository_owner,
          document.repository_name, document.relative_path
        FROM document_blocks block
        INNER JOIN documents document ON document.id = block.document_id
        LEFT JOIN entity_mentions mention ON mention.block_id = block.id
        WHERE document.status IN ('completed', 'unchanged') AND (${blockMatch.sql})
        ORDER BY block.document_id, block.ordinal, mention.entity_id
        LIMIT 120`).bind(...blockMatch.bindings).all<Record<string, unknown>>(),
  ]);

  const candidateNodes = entityResult.results.map(knowledgeNodeFromRow);
  const matchingCitations = graphCitationFromRows(blockResult.results);
  const blockNodeIds = matchingCitations.flatMap((citation) => citation.nodeIds);
  const missingBlockNodes = await loadGraphNodesById(
    db,
    blockNodeIds.filter((id) => !candidateNodes.some((node) => node.id === id)),
  );
  const initialNodes = [...new Map([...candidateNodes, ...missingBlockNodes].map((node) => [node.id, node])).values()];
  const lexicalSeeds = initialNodes
    .map((node) => ({ node, score: graphNodeLexicalMatch(node, query).score }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id))
    .slice(0, 18)
    .map((item) => item.node.id);
  const seedIds = [...new Set([...lexicalSeeds, ...blockNodeIds])].slice(0, 24);
  if (!seedIds.length) return { nodes: initialNodes, edges: [], citations: matchingCitations };

  const firstHopEdges = await graphRelationQuery(db, seedIds, 240);
  const firstHopIds = [...new Set(firstHopEdges.flatMap((edge) => [edge.source, edge.target]))]
    .filter((id) => !seedIds.includes(id))
    .slice(0, 48);
  const secondHopEdges = await graphRelationQuery(db, firstHopIds, 320);
  const secondHopIds = [...new Set(secondHopEdges.flatMap((edge) => [edge.source, edge.target]))]
    .filter((id) => !seedIds.includes(id) && !firstHopIds.includes(id))
    .slice(0, 72);
  const allowedIds = new Set([...seedIds, ...firstHopIds, ...secondHopIds]);
  const edgeMap = new Map<string, KnowledgeEdge>();
  for (const edge of [...firstHopEdges, ...secondHopEdges]) {
    if (!allowedIds.has(edge.source) || !allowedIds.has(edge.target)) continue;
    edgeMap.set(`${edge.source}|${edge.target}|${edge.type}`, edge);
  }
  const edges = [...edgeMap.values()];
  const nodes = await loadGraphNodesById(db, [...allowedIds]);

  const relationEvidenceNodes = new Map<string, Set<string>>();
  for (const edge of edges) {
    for (const evidence of edge.evidence ?? []) {
      const nodeIds = relationEvidenceNodes.get(evidence.blockId) ?? new Set<string>();
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
      relationEvidenceNodes.set(evidence.blockId, nodeIds);
    }
  }
  const knownCitationIds = new Set(matchingCitations.map((citation) => citation.id));
  const evidenceBlockIds = [...relationEvidenceNodes.keys()]
    .filter((id) => !knownCitationIds.has(id))
    .slice(0, 80);
  const evidenceRows: Record<string, unknown>[] = [];
  for (let index = 0; index < evidenceBlockIds.length; index += 60) {
    const chunk = evidenceBlockIds.slice(index, index + 60);
    const result = await db.prepare(`SELECT block.id AS block_id, block.document_id,
        block.text AS block_text, COALESCE(mention.source_url, block.source_url, document.source_url) AS source_url,
        mention.entity_id, document.file_name, document.repository_owner,
        document.repository_name, document.relative_path
      FROM document_blocks block
      INNER JOIN documents document ON document.id = block.document_id
      LEFT JOIN entity_mentions mention ON mention.block_id = block.id
      WHERE block.id IN (${chunk.map(() => "?").join(",")})
      ORDER BY block.id, mention.entity_id`).bind(...chunk).all<Record<string, unknown>>();
    evidenceRows.push(...result.results);
  }
  const evidenceCitations = graphCitationFromRows(evidenceRows, relationEvidenceNodes);
  return {
    nodes,
    edges,
    citations: [...matchingCitations, ...evidenceCitations]
      .filter((citation, index, all) => all.findIndex((item) => item.id === citation.id) === index),
  };
}

export async function listGraphDocuments(limit = 8): Promise<GraphDocumentSummary[]> {
  const boundedLimit = Math.max(1, Math.min(12, Math.floor(limit)));
  const db = await database();
  if (!db) {
    return [...memoryStore().documents.values()]
      .filter((document) => document.status === "completed" || document.status === "unchanged")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .slice(0, boundedLimit)
      .map(toPublicDocumentRecord)
      .map(toGraphDocumentSummary);
  }
  await ensureSchema(db);
  const result = await db.prepare(`SELECT * FROM documents
    WHERE status IN ('completed', 'unchanged')
    ORDER BY updated_at DESC, id
    LIMIT ?`).bind(boundedLimit).all<Record<string, unknown>>();
  return result.results
    .map(asStoredDocument)
    .map(toPublicDocumentRecord)
    .map(toGraphDocumentSummary);
}

export async function searchGraphNodeIndex(
  query: NormalizedGraphQuestion,
  limit = 8,
): Promise<GraphNodeSearchResult[]> {
  const boundedLimit = Math.max(1, Math.min(12, Math.floor(limit)));
  const source = await getGraphRetrievalSource(query);
  const candidates = source.nodes
    .map((node) => ({ node, score: graphNodeLexicalMatch(node, query).score }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.node.label.localeCompare(right.node.label)
      || left.node.id.localeCompare(right.node.id))
    .slice(0, boundedLimit);
  if (!candidates.length) return [];

  const db = await database();
  const documentByNodeId = new Map<string, GraphDocumentSummary>();
  if (!db) {
    const documents = [...memoryStore().documents.values()]
      .filter((document) => document.status === "completed" || document.status === "unchanged")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    for (const candidate of candidates) {
      const document = documents.find((item) => item.graph.nodes.some((node) => node.id === candidate.node.id));
      if (document) {
        documentByNodeId.set(
          candidate.node.id,
          toGraphDocumentSummary(toPublicDocumentRecord(document)),
        );
      }
    }
  } else {
    await ensureSchema(db);
    const candidateIds = candidates.map((item) => item.node.id);
    const result = await db.prepare(`SELECT mention.entity_id, document.*
      FROM entity_mentions mention
      INNER JOIN documents document ON document.id = mention.document_id
      WHERE mention.entity_id IN (${candidateIds.map(() => "?").join(",")})
        AND document.status IN ('completed', 'unchanged')
      ORDER BY document.updated_at DESC, document.id`)
      .bind(...candidateIds)
      .all<Record<string, unknown>>();
    for (const row of result.results) {
      const nodeId = String(row.entity_id);
      if (documentByNodeId.has(nodeId)) continue;
      documentByNodeId.set(
        nodeId,
        toGraphDocumentSummary(toPublicDocumentRecord(asStoredDocument(row))),
      );
    }
  }

  return candidates.map((candidate) => ({
    ...candidate,
    document: documentByNodeId.get(candidate.node.id),
  }));
}

/**
 * Loads only the graph slice required by the public projection. The previous
 * implementation loaded the complete corpus for every overview/repository
 * request, making the 853-document corpus pay the 90k-node cost before it was
 * reduced to at most 500 nodes.
 */
export async function getGraphSnapshotForScope(input: {
  scope: "corpus" | "overview" | "repository" | "document";
  repositoryId?: string;
  documentId?: string;
}): Promise<GraphSnapshot> {
  const db = await database();
  if (!db) {
    const snapshot = await getGraphSnapshot();
    if (input.scope !== "document") return snapshot;
    const document = input.documentId
      ? memoryStore().documents.get(input.documentId)
      : undefined;
    if (!document) {
      return {
        nodes: [],
        edges: [],
        meta: {
          ...snapshot.meta,
          scope: "document",
          documentId: input.documentId,
          documentSeedNodeIds: [],
        },
      };
    }
    return {
      ...snapshot,
      meta: {
        ...snapshot.meta,
        scope: "document",
        documentId: document.id,
        documentName: document.fileName,
        documentSourceLabel: toPublicDocumentRecord(document).sourceLabel,
        documentUpdatedAt: document.updatedAt,
        documentSeedNodeIds: document.graph.nodes.map((node) => node.id),
        repositoryId: document.sourceDescriptor.type === "github"
          ? document.sourceDescriptor.repositoryId
          : undefined,
      },
    };
  }
  await ensureSchema(db);
  const [revisionRows, repositoryCountResult] = await Promise.all([
    graphRevisionRows(db),
    db.prepare("SELECT COUNT(*) AS count FROM entities WHERE id LIKE 'repository:github:%'")
      .first<{ count: number }>(),
  ]);
  const documentResult = revisionRows.documentResult;
  const corpusNodeResult = revisionRows.entityResult;
  const corpusEdgeResult = revisionRows.relationResult;
  const graphRevision = graphRevisionFromRows(revisionRows);
  const snapshotFromResults = (
    nodeResult: D1Result<Record<string, unknown>>,
    edgeResult: D1Result<Record<string, unknown>>,
  ): GraphSnapshot => {
    const nodes = nodeResult.results.map(knowledgeNodeFromRow);
    const nodeIds = new Set(nodes.map((node) => node.id));
    return {
      nodes,
      edges: edgeResult.results.map(knowledgeEdgeFromRow)
        .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)),
      meta: {
        source: "documents",
        provider: "markdown-ast",
        generatedAt: new Date().toISOString(),
        documentCount: Number(documentResult?.count ?? 0),
        repositoryCount: Number(repositoryCountResult?.count ?? 0),
        corpusNodeCount: Number(corpusNodeResult?.count ?? 0),
        corpusEdgeCount: Number(corpusEdgeResult?.count ?? 0),
        graphRevision,
      },
    };
  };

  if (input.scope === "document") {
    const documentRow = input.documentId
      ? await db.prepare(`SELECT * FROM documents
          WHERE id = ? AND status IN ('completed', 'unchanged')`)
        .bind(input.documentId)
        .first<Record<string, unknown>>()
      : null;
    if (!documentRow) {
      return {
        nodes: [],
        edges: [],
        meta: {
          source: "documents",
          provider: "markdown-ast",
          generatedAt: new Date().toISOString(),
          documentCount: Number(documentResult?.count ?? 0),
          repositoryCount: Number(repositoryCountResult?.count ?? 0),
          corpusNodeCount: Number(corpusNodeResult?.count ?? 0),
          corpusEdgeCount: Number(corpusEdgeResult?.count ?? 0),
          graphRevision,
          scope: "document",
          documentId: input.documentId,
          documentSeedNodeIds: [],
        },
      };
    }
    const storedDocument = asStoredDocument(documentRow);
    const mentionResult = await db.prepare(`SELECT DISTINCT entity_id
      FROM entity_mentions WHERE document_id = ? ORDER BY entity_id`)
      .bind(storedDocument.id)
      .all<{ entity_id: string }>();
    const seedIds = mentionResult.results.map((row) => String(row.entity_id));
    const firstHopEdges = await graphRelationQueryChunked(db, seedIds, 8_000);
    const seedIdSet = new Set(seedIds);
    const firstHopIds = [...new Set(firstHopEdges.flatMap((edge) => [edge.source, edge.target]))]
      .filter((id) => !seedIdSet.has(id))
      .slice(0, 800);
    const secondHopEdges = await graphRelationQueryChunked(db, firstHopIds, 8_000);
    const firstHopIdSet = new Set(firstHopIds);
    const secondHopIds = [...new Set(secondHopEdges.flatMap((edge) => [edge.source, edge.target]))]
      .filter((id) => !seedIdSet.has(id) && !firstHopIdSet.has(id))
      .slice(0, 1_200);
    const allowedIds = new Set([...seedIds, ...firstHopIds, ...secondHopIds]);
    const edgeMap = new Map<string, KnowledgeEdge>();
    for (const edge of [...firstHopEdges, ...secondHopEdges]) {
      if (!allowedIds.has(edge.source) || !allowedIds.has(edge.target)) continue;
      edgeMap.set(`${edge.source}|${edge.target}|${edge.type}`, edge);
    }
    const nodes = await loadGraphNodesById(db, [...allowedIds]);
    return {
      nodes,
      edges: [...edgeMap.values()],
      meta: {
        source: "documents",
        provider: "markdown-ast",
        generatedAt: new Date().toISOString(),
        documentCount: Number(documentResult?.count ?? 0),
        repositoryCount: Number(repositoryCountResult?.count ?? 0),
        corpusNodeCount: Number(corpusNodeResult?.count ?? 0),
        corpusEdgeCount: Number(corpusEdgeResult?.count ?? 0),
        graphRevision,
        scope: "document",
        documentId: storedDocument.id,
        documentName: storedDocument.fileName,
        documentSourceLabel: toPublicDocumentRecord(storedDocument).sourceLabel,
        documentUpdatedAt: storedDocument.updatedAt,
        documentSeedNodeIds: seedIds,
        repositoryId: storedDocument.sourceDescriptor.type === "github"
          ? storedDocument.sourceDescriptor.repositoryId
          : undefined,
      },
    };
  }

  if (input.scope === "corpus") {
    const fingerprint = `${graphRevision}:${repositoryCountResult?.count ?? 0}`;
    const corpusSelectionCte = `WITH degree AS (
      SELECT id, COUNT(*) AS degree FROM (
        SELECT source_id AS id FROM relations
        UNION ALL
        SELECT target_id AS id FROM relations
      ) GROUP BY id
    ), repositories AS (
      SELECT entity.id FROM entities entity
      LEFT JOIN degree ON degree.id = entity.id
      WHERE entity.id LIKE 'repository:github:%'
      ORDER BY COALESCE(degree.degree, 0) DESC, entity.id
      LIMIT 24
    ), anchors AS (
      SELECT degree.id FROM degree
      WHERE degree.id NOT IN (SELECT id FROM repositories)
        AND degree.id NOT LIKE 'repository:github:%'
      ORDER BY degree.degree DESC, degree.id
      LIMIT 40
    ), seeds AS (
      SELECT id FROM repositories
      UNION
      SELECT id FROM anchors
    ), candidates AS (
      SELECT id FROM seeds
      UNION
      SELECT relation.source_id FROM relations relation
      WHERE relation.target_id IN (SELECT id FROM seeds)
      UNION
      SELECT relation.target_id FROM relations relation
      WHERE relation.source_id IN (SELECT id FROM seeds)
    )`;
    return corpusSnapshotCacheFor(db).get(fingerprint, async () => {
      const [nodeResult, edgeResult] = await Promise.all([
        db.prepare(`${corpusSelectionCte}
          SELECT entity.* FROM entities entity
          INNER JOIN candidates ON candidates.id = entity.id
          ORDER BY entity.id`).all<Record<string, unknown>>(),
        db.prepare(`${corpusSelectionCte}
          SELECT DISTINCT relation.source_id, relation.target_id, relation.type,
            relation.confidence, relation.note, relation.evidence_json, relation.origin, relation.provider
          FROM relations relation
          INNER JOIN candidates source ON source.id = relation.source_id
          INNER JOIN candidates target ON target.id = relation.target_id
          ORDER BY relation.confidence DESC, relation.source_id, relation.target_id, relation.type
          LIMIT 12000`).all<Record<string, unknown>>(),
      ]);
      return snapshotFromResults(nodeResult, edgeResult);
    });
  }

  let nodeResult: D1Result<Record<string, unknown>>;
  let edgeResult: D1Result<Record<string, unknown>>;
  if (input.scope === "overview") {
    const eligibleNode = `(id LIKE 'repository:github:%'
      OR (tags_json LIKE '%"technology"%' AND tags_json LIKE '%"shared"%'))`;
    nodeResult = await db.prepare(`SELECT * FROM entities WHERE ${eligibleNode} ORDER BY id`)
      .all<Record<string, unknown>>();
    edgeResult = await db.prepare(`SELECT DISTINCT r.source_id, r.target_id, r.type,
        r.confidence, r.note, r.evidence_json, r.origin, r.provider
      FROM relations r
      INNER JOIN entities source ON source.id = r.source_id
      INNER JOIN entities target ON target.id = r.target_id
      WHERE (source.id LIKE 'repository:github:%'
          OR (source.tags_json LIKE '%"technology"%' AND source.tags_json LIKE '%"shared"%'))
        AND (target.id LIKE 'repository:github:%'
          OR (target.tags_json LIKE '%"technology"%' AND target.tags_json LIKE '%"shared"%'))
      ORDER BY r.source_id, r.target_id, r.type`).all<Record<string, unknown>>();
  } else {
    const repositoryNodeId = `repository:github:${input.repositoryId ?? ""}`;
    const reachableCte = `WITH RECURSIVE reachable(id) AS (
      SELECT ?
      UNION
      SELECT relation.target_id
      FROM relations relation
      INNER JOIN reachable parent ON parent.id = relation.source_id
      WHERE relation.target_id = ? OR relation.target_id NOT LIKE 'repository:github:%'
    )`;
    nodeResult = await db.prepare(`${reachableCte}
      SELECT entity.* FROM entities entity INNER JOIN reachable ON reachable.id = entity.id
      ORDER BY entity.id`).bind(repositoryNodeId, repositoryNodeId).all<Record<string, unknown>>();
    edgeResult = await db.prepare(`${reachableCte}
      SELECT DISTINCT relation.source_id, relation.target_id, relation.type,
        relation.confidence, relation.note, relation.evidence_json, relation.origin, relation.provider
      FROM relations relation
      INNER JOIN reachable source ON source.id = relation.source_id
      INNER JOIN reachable target ON target.id = relation.target_id
      ORDER BY relation.source_id, relation.target_id, relation.type`)
      .bind(repositoryNodeId, repositoryNodeId).all<Record<string, unknown>>();
  }

  return snapshotFromResults(nodeResult, edgeResult);
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
    if (keys.has(key)) {
      const existing = document.graph.edges.find((edge) =>
        edge.source === relation.source
        && edge.target === relation.target
        && edge.type === relation.type);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, relation.confidence);
        if (relation.note.length > existing.note.length) existing.note = relation.note;
        const evidence = [...(existing.evidence ?? []), ...relation.evidence];
        existing.evidence = [...new Map(evidence.map((item) => [
          `${item.blockId}\u0000${item.explanation}`,
          item,
        ] as const)).values()].sort((left, right) =>
          left.blockId.localeCompare(right.blockId)
          || left.explanation.localeCompare(right.explanation));
      }
      return;
    }
    keys.add(key);
    document.graph.edges.push({
      source: relation.source,
      target: relation.target,
      type: relation.type,
      confidence: relation.confidence,
      note: relation.note,
      evidence: relation.evidence,
      layer: "inferred",
      origin: "codex",
      provider: result.provider,
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
