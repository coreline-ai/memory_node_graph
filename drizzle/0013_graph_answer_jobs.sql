CREATE TABLE IF NOT EXISTS `graph_answer_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `idempotency_key` text NOT NULL,
  `status` text NOT NULL,
  `input_json` text NOT NULL,
  `result_json` text,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `max_attempts` integer DEFAULT 3 NOT NULL,
  `manual_retry_count` integer DEFAULT 0 NOT NULL,
  `last_manual_retry_at` text,
  `lease_owner` text,
  `lease_expires_at` text,
  `error_code` text,
  `error_message` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `started_at` text,
  `completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `graph_answer_jobs_idempotency_unique`
  ON `graph_answer_jobs` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `graph_answer_jobs_claim_idx`
  ON `graph_answer_jobs` (`status`, `lease_expires_at`, `created_at`);
