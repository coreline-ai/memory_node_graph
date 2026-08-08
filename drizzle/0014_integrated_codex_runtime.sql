ALTER TABLE connector_heartbeats ADD COLUMN runtime_state TEXT;
--> statement-breakpoint
ALTER TABLE connector_heartbeats ADD COLUMN runtime_message TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS enrichment_jobs_provider_claim_idx
  ON enrichment_jobs(provider_version, status, lease_expires_at, created_at);
