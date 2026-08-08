ALTER TABLE github_source_jobs ADD COLUMN runtime_version TEXT;
--> statement-breakpoint
CREATE INDEX github_source_jobs_runtime_claim_idx
  ON github_source_jobs(runtime_version, status, lease_expires_at, created_at);
