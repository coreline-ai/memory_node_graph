ALTER TABLE relations ADD COLUMN provider TEXT;
ALTER TABLE relations ADD COLUMN provider_version TEXT;
ALTER TABLE relations ADD COLUMN prompt_version TEXT;
ALTER TABLE relations ADD COLUMN evidence_json TEXT;
ALTER TABLE relations ADD COLUMN created_at TEXT;

ALTER TABLE staged_relations ADD COLUMN provider TEXT;
ALTER TABLE staged_relations ADD COLUMN provider_version TEXT;
ALTER TABLE staged_relations ADD COLUMN prompt_version TEXT;
ALTER TABLE staged_relations ADD COLUMN evidence_json TEXT;
ALTER TABLE staged_relations ADD COLUMN created_at TEXT;

UPDATE relations
SET provider = COALESCE(provider, 'markdown-ast'),
    provider_version = COALESCE(provider_version, 'legacy'),
    evidence_json = COALESCE(evidence_json, '[]');

CREATE TABLE IF NOT EXISTS enrichment_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  document_id TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS enrichment_jobs_claim_idx
  ON enrichment_jobs(status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS enrichment_jobs_document_idx
  ON enrichment_jobs(document_id, created_at);
