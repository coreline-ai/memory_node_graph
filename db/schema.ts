import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  normalizedName: text("normalized_name").notNull().unique(),
  source: text("source").notNull(),
  size: integer("size").notNull(),
  hash: text("hash").notNull(),
  status: text("status").notNull(),
  nodeCount: integer("node_count").notNull().default(0),
  edgeCount: integer("edge_count").notNull().default(0),
  parserVersion: text("parser_version").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const documentBlocks = sqliteTable("document_blocks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  type: text("type").notNull(),
  depth: integer("depth").notNull().default(0),
  text: text("text").notNull(),
  ordinal: integer("ordinal").notNull(),
});

export const entities = sqliteTable("entities", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  shortLabel: text("short_label").notNull(),
  kind: text("kind").notNull(),
  domain: text("domain").notNull(),
  summary: text("summary").notNull(),
  insight: text("insight").notNull(),
  tags: text("tags_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const entityMentions = sqliteTable("entity_mentions", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  entityId: text("entity_id").notNull(),
  blockId: text("block_id"),
  origin: text("origin").notNull().default("rule"),
});

export const relations = sqliteTable("relations", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  sourceId: text("source_id").notNull(),
  targetId: text("target_id").notNull(),
  type: text("type").notNull(),
  confidence: real("confidence").notNull(),
  note: text("note").notNull(),
  origin: text("origin").notNull().default("rule"),
  provider: text("provider"),
  providerVersion: text("provider_version"),
  promptVersion: text("prompt_version"),
  evidence: text("evidence_json"),
  createdAt: text("created_at"),
});

export const ingestionJobs = sqliteTable("ingestion_jobs", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull(),
  progress: integer("progress").notNull().default(0),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
});

export const enrichmentJobs = sqliteTable("enrichment_jobs", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  documentId: text("document_id").notNull(),
  documentHash: text("document_hash").notNull(),
  parserVersion: text("parser_version").notNull(),
  provider: text("provider").notNull(),
  providerVersion: text("provider_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  status: text("status").notNull(),
  input: text("input_json").notNull(),
  result: text("result_json"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  manualRetryCount: integer("manual_retry_count").notNull().default(0),
  lastManualRetryAt: text("last_manual_retry_at"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: text("lease_expires_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

export const connectorHeartbeats = sqliteTable("connector_heartbeats", {
  connectorId: text("connector_id").primaryKey(),
  status: text("status").notNull(),
  version: text("version").notNull(),
  currentJobId: text("current_job_id"),
  startedAt: text("started_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

export const stagedDocumentBlocks = sqliteTable("staged_document_blocks", {
  stageId: text("stage_id").notNull(),
  id: text("id").notNull(),
  documentId: text("document_id").notNull(),
  type: text("type").notNull(),
  depth: integer("depth").notNull().default(0),
  text: text("text").notNull(),
  ordinal: integer("ordinal").notNull(),
}, (table) => [primaryKey({ columns: [table.stageId, table.id] })]);

export const stagedEntities = sqliteTable("staged_entities", {
  stageId: text("stage_id").notNull(),
  id: text("id").notNull(),
  label: text("label").notNull(),
  shortLabel: text("short_label").notNull(),
  kind: text("kind").notNull(),
  domain: text("domain").notNull(),
  summary: text("summary").notNull(),
  insight: text("insight").notNull(),
  tags: text("tags_json").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.stageId, table.id] })]);

export const stagedEntityMentions = sqliteTable("staged_entity_mentions", {
  stageId: text("stage_id").notNull(),
  id: text("id").notNull(),
  documentId: text("document_id").notNull(),
  entityId: text("entity_id").notNull(),
  blockId: text("block_id"),
  origin: text("origin").notNull().default("rule"),
}, (table) => [primaryKey({ columns: [table.stageId, table.id] })]);

export const stagedRelations = sqliteTable("staged_relations", {
  stageId: text("stage_id").notNull(),
  id: text("id").notNull(),
  documentId: text("document_id").notNull(),
  sourceId: text("source_id").notNull(),
  targetId: text("target_id").notNull(),
  type: text("type").notNull(),
  confidence: real("confidence").notNull(),
  note: text("note").notNull(),
  origin: text("origin").notNull().default("rule"),
  provider: text("provider"),
  providerVersion: text("provider_version"),
  promptVersion: text("prompt_version"),
  evidence: text("evidence_json"),
  createdAt: text("created_at"),
}, (table) => [primaryKey({ columns: [table.stageId, table.id] })]);
