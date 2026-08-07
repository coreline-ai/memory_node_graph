CREATE TABLE documents_source_migration (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'manual',
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
  node_count INTEGER NOT NULL DEFAULT 0,
  edge_count INTEGER NOT NULL DEFAULT 0,
  parser_version TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO documents_source_migration (
  id, file_name, normalized_name, source, source_type, source_key,
  size, hash, status, node_count, edge_count, parser_version, error,
  created_at, updated_at
)
SELECT
  id, file_name, normalized_name, source, 'manual', 'manual:' || normalized_name,
  size, hash, status, node_count, edge_count, parser_version, error,
  created_at, updated_at
FROM documents;

DROP TABLE documents;
ALTER TABLE documents_source_migration RENAME TO documents;

CREATE UNIQUE INDEX documents_source_key_unique ON documents(source_key);
CREATE INDEX documents_repository_idx ON documents(repository_id, relative_path);

CREATE TABLE github_repositories (
  repository_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL,
  is_private INTEGER NOT NULL DEFAULT 0,
  is_fork INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  is_template INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL,
  sync_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'discovered',
  last_seen_at TEXT NOT NULL,
  last_synced_at TEXT,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX github_repositories_selection_idx
  ON github_repositories(sync_enabled, status);

CREATE TABLE github_sync_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  selection_digest TEXT,
  manifest_digest TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX github_sync_runs_status_idx
  ON github_sync_runs(status, created_at);
