ALTER TABLE `jobs` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `max_attempts` integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `worker_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `dispatched_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `acked_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `cancel_requested_at` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `progress_message` text;--> statement-breakpoint
CREATE INDEX `jobs_queue_idx` ON `jobs` (`status`,`priority`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `jobs` (`status`,`lease_expires_at`);