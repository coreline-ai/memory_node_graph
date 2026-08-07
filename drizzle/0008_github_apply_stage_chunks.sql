CREATE TABLE github_apply_stage_chunks (
  job_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, chunk_index)
);

CREATE INDEX github_apply_stage_chunks_job_idx
  ON github_apply_stage_chunks(job_id, chunk_index);
