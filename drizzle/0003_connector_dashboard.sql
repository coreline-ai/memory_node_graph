ALTER TABLE enrichment_jobs ADD COLUMN manual_retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE enrichment_jobs ADD COLUMN last_manual_retry_at TEXT;

CREATE TABLE IF NOT EXISTS connector_heartbeats (
  connector_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  version TEXT NOT NULL,
  current_job_id TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_heartbeats_seen_idx
  ON connector_heartbeats(last_seen_at);
