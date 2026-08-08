-- Phase 7: the launcher-owned OAuth runtime replaces the separately started
-- Connector process. Historical tables are retained by migration policy; the
-- runtime repositories copy only newer status rows into these new tables.
CREATE TABLE IF NOT EXISTS runtime_status (
  runtime_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  version TEXT NOT NULL,
  current_job_id TEXT,
  runtime_state TEXT,
  runtime_message TEXT,
  run_mode TEXT,
  max_jobs INTEGER,
  max_runtime_ms INTEGER,
  processed_jobs INTEGER,
  succeeded_jobs INTEGER,
  warning_jobs INTEGER,
  failed_jobs INTEGER,
  stop_reason TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS runtime_status_seen_idx ON runtime_status(last_seen_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS github_runtime_status (
  runtime_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  account_login TEXT,
  host TEXT,
  rate_limit_reset_at TEXT,
  message TEXT,
  checked_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (runtime_id, capability)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS github_runtime_status_seen_idx
  ON github_runtime_status(status, last_seen_at);
