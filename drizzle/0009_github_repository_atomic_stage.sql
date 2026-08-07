CREATE TABLE staged_documents (
  stage_id TEXT NOT NULL,
  id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  repository_id TEXT,
  repository_owner TEXT,
  repository_name TEXT,
  relative_path TEXT,
  source_ref TEXT,
  commit_sha TEXT,
  blob_sha TEXT,
  source_url TEXT,
  last_seen_sync_id TEXT,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  status TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  parser_version TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE TABLE staged_ingestion_jobs (
  stage_id TEXT NOT NULL,
  id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (stage_id, id)
);

CREATE TABLE staged_github_document_targets (
  stage_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('prepared', 'unchanged')),
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  blob_sha TEXT NOT NULL,
  source_url TEXT NOT NULL,
  PRIMARY KEY (stage_id, source_key)
);

CREATE INDEX staged_documents_stage_idx ON staged_documents(stage_id);
CREATE INDEX staged_ingestion_jobs_stage_idx ON staged_ingestion_jobs(stage_id);
CREATE INDEX staged_github_document_targets_stage_idx
  ON staged_github_document_targets(stage_id, mode);
