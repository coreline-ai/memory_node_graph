ALTER TABLE `connector_heartbeats` ADD `run_mode` text;
--> statement-breakpoint
ALTER TABLE `connector_heartbeats` ADD `max_jobs` integer;
--> statement-breakpoint
ALTER TABLE `connector_heartbeats` ADD `max_runtime_ms` integer;
--> statement-breakpoint
ALTER TABLE `connector_heartbeats` ADD `processed_jobs` integer;
--> statement-breakpoint
ALTER TABLE `connector_heartbeats` ADD `succeeded_jobs` integer;
--> statement-breakpoint
ALTER TABLE `connector_heartbeats` ADD `warning_jobs` integer;
--> statement-breakpoint
ALTER TABLE `connector_heartbeats` ADD `failed_jobs` integer;
--> statement-breakpoint
ALTER TABLE `connector_heartbeats` ADD `stop_reason` text;
