ALTER TABLE github_sync_runs ADD COLUMN receipt_json TEXT;

ALTER TABLE github_source_jobs ADD COLUMN repository_id TEXT;

UPDATE github_source_jobs
SET repository_id = json_extract(input_json, '$.selectedRepositoryIds[0]')
WHERE kind = 'apply' AND repository_id IS NULL;

CREATE UNIQUE INDEX github_source_jobs_active_apply_unique
  ON github_source_jobs(repository_id)
  WHERE kind = 'apply' AND status IN ('queued', 'leased', 'running');
