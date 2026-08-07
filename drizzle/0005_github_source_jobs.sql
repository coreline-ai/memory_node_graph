CREATE TABLE github_source_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  manual_retry_count INTEGER NOT NULL DEFAULT 0,
  last_manual_retry_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX github_source_jobs_claim_idx
  ON github_source_jobs(status, lease_expires_at, created_at);

CREATE UNIQUE INDEX github_source_jobs_idempotency_unique
  ON github_source_jobs(idempotency_key);

CREATE TABLE github_connector_capabilities (
  connector_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  account_login TEXT,
  host TEXT,
  rate_limit_reset_at TEXT,
  message TEXT,
  checked_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, capability)
);

CREATE INDEX github_connector_capabilities_seen_idx
  ON github_connector_capabilities(status, last_seen_at);
