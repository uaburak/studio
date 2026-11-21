CREATE TABLE `host_settings_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text,
	`values` text NOT NULL,
	`keys` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	CONSTRAINT "host_settings_changes_status_check" CHECK("host_settings_changes"."status" in ('pending', 'applied', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `host_settings_changes_status_idx` ON `host_settings_changes` (`status`,`created_at`);