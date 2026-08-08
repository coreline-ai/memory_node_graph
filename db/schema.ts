import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  source: text("source").notNull(),
  sourceType: text("source_type").notNull().default("manual"),
  sourceKey: text("source_key").notNull(),
  repositoryId: text("repository_id"),
  repositoryOwner: text("repository_owner"),
  repositoryName: text("repository_name"),
  relativePath: text("relative_path"),
  sourceRef: text("source_ref"),
  commitSha: text("commit_sha"),
  blobSha: text("blob_sha"),
  sourceUrl: text("source_url"),
  lastSeenSyncId: text("last_seen_sync_id"),
  size: integer("size").notNull(),
  hash: text("hash").notNull(),
  status: text("status").notNull(),
  nodeCount: integer("node_count").notNull().default(0),
  edgeCount: integer("edge_count").notNull().default(0),
  parserVersion: text("parser_version").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("documents_source_key_unique").on(table.sourceKey),
  index("documents_repository_idx").on(table.repositoryId, table.relativePath),
]);

export const githubRepositories = sqliteTable("github_repositories", {
  repositoryId: text("repository_id").primaryKey(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  visibility: text("visibility").notNull(),
  isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
  isFork: integer("is_fork", { mode: "boolean" }).notNull().default(false),
  isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
  isTemplate: integer("is_template", { mode: "boolean" }).notNull().default(false),
  defaultBranch: text("default_branch").notNull(),
  syncEnabled: integer("sync_enabled", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("discovered"),
  lastSeenAt: text("last_seen_at").notNull(),
  lastSyncedAt: text("last_synced_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
}, (table) => [
  index("github_repositories_selection_idx").on(table.syncEnabled, table.status),
]);

export const githubSyncRuns = sqliteTable("github_sync_runs", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  selectionDigest: text("selection_digest"),
  manifestDigest: text("manifest_digest"),
  discoveredCount: integer("discovered_count").notNull().default(0),
  selectedCount: integer("selected_count").notNull().default(0),
  changedCount: integer("changed_count").notNull().default(0),
  unchangedCount: integer("unchanged_count").notNull().default(0),
  deletedCount: integer("deleted_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  receipt: text("receipt_json"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
}, (table) => [
  index("github_sync_runs_status_idx").on(table.status, table.createdAt),
]);

export const githubSourceJobs = sqliteTable("github_source_jobs", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  kind: text("kind").notNull(),
  owner: text("owner").notNull(),
  repositoryId: text("repository_id"),
  runtimeVersion: text("runtime_version"),
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
}, (table) => [
  uniqueIndex("github_source_jobs_idempotency_unique").on(table.idempotencyKey),
  index("github_source_jobs_claim_idx").on(table.status, table.leaseExpiresAt, table.createdAt),
  index("github_source_jobs_runtime_claim_idx").on(
    table.runtimeVersion,
    table.status,
    table.leaseExpiresAt,
    table.createdAt,
  ),
]);

export const githubRuntimeStatuses = sqliteTable("github_runtime_status", {
  runtimeId: text("runtime_id").notNull(),
  capability: text("capability").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
  accountLogin: text("account_login"),
  host: text("host"),
  rateLimitResetAt: text("rate_limit_reset_at"),
  message: text("message"),
  checkedAt: text("checked_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.runtimeId, table.capability] }),
  index("github_runtime_status_seen_idx").on(table.status, table.lastSeenAt),
]);

export const documentBlocks = sqliteTable("document_blocks", {
  id: text("id").primaryKey(),
  documentId: text("document_id").notNull(),
  type: text("type").notNull(),
  depth: integer("depth").notNull().default(0),
  text: text("text").notNull(),
  ordinal: integer("ordinal").notNull(),
  sourceUrl: text("source_url"),
});

export const githubApplyStageChunks = sqliteTable("github_apply_stage_chunks", {
  jobId: text("job_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  totalChunks: integer("total_chunks").notNull(),
  checksum: text("checksum").notNull(),
  payload: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.jobId, table.chunkIndex] }),
  index("github_apply_stage_chunks_job_idx").on(table.jobId, table.chunkIndex),
]);

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
  sourceUrl: text("source_url"),
  origin: text("origin").notNull().default("rule"),
}, (table) => [
  index("entity_mentions_document_idx").on(table.documentId),
]);

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
}, (table) => [
  index("relations_source_idx").on(table.sourceId),
  index("relations_target_idx").on(table.targetId),
  index("relations_document_idx").on(table.documentId),
]);

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

export const graphAnswerJobs = sqliteTable("graph_answer_jobs", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
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
}, (table) => [
  uniqueIndex("graph_answer_jobs_idempotency_unique").on(table.idempotencyKey),
  index("graph_answer_jobs_claim_idx").on(table.status, table.leaseExpiresAt, table.createdAt),
]);

export const runtimeStatuses = sqliteTable("runtime_status", {
  runtimeId: text("runtime_id").primaryKey(),
  status: text("status").notNull(),
  version: text("version").notNull(),
  currentJobId: text("current_job_id"),
  runtimeState: text("runtime_state"),
  runtimeMessage: text("runtime_message"),
  runMode: text("run_mode"),
  maxJobs: integer("max_jobs"),
  maxRuntimeMs: integer("max_runtime_ms"),
  processedJobs: integer("processed_jobs"),
  succeededJobs: integer("succeeded_jobs"),
  warningJobs: integer("warning_jobs"),
  failedJobs: integer("failed_jobs"),
  stopReason: text("stop_reason"),
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
  sourceUrl: text("source_url"),
}, (table) => [primaryKey({ columns: [table.stageId, table.id] })]);

export const stagedDocuments = sqliteTable("staged_documents", {
  stageId: text("stage_id").notNull(),
  id: text("id").notNull(),
  fileName: text("file_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  source: text("source").notNull(),
  sourceType: text("source_type").notNull(),
  sourceKey: text("source_key").notNull(),
  repositoryId: text("repository_id"),
  repositoryOwner: text("repository_owner"),
  repositoryName: text("repository_name"),
  relativePath: text("relative_path"),
  sourceRef: text("source_ref"),
  commitSha: text("commit_sha"),
  blobSha: text("blob_sha"),
  sourceUrl: text("source_url"),
  lastSeenSyncId: text("last_seen_sync_id"),
  size: integer("size").notNull(),
  hash: text("hash").notNull(),
  status: text("status").notNull(),
  nodeCount: integer("node_count").notNull(),
  edgeCount: integer("edge_count").notNull(),
  parserVersion: text("parser_version").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.stageId, table.id] })]);

export const stagedIngestionJobs = sqliteTable("staged_ingestion_jobs", {
  stageId: text("stage_id").notNull(),
  id: text("id").notNull(),
  documentId: text("document_id").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull(),
  progress: integer("progress").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [primaryKey({ columns: [table.stageId, table.id] })]);

export const stagedGitHubDocumentTargets = sqliteTable("staged_github_document_targets", {
  stageId: text("stage_id").notNull(),
  sourceKey: text("source_key").notNull(),
  mode: text("mode").notNull(),
  repositoryOwner: text("repository_owner").notNull(),
  repositoryName: text("repository_name").notNull(),
  relativePath: text("relative_path").notNull(),
  sourceRef: text("source_ref").notNull(),
  commitSha: text("commit_sha").notNull(),
  blobSha: text("blob_sha").notNull(),
  sourceUrl: text("source_url").notNull(),
}, (table) => [primaryKey({ columns: [table.stageId, table.sourceKey] })]);

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
  sourceUrl: text("source_url"),
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
