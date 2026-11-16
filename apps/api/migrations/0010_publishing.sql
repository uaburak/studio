CREATE TABLE `publishing_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`cloud_url` text,
	`cloud_token_ciphertext` text,
	`cloud_token_iv` text,
	`cloud_token_key_version` integer,
	`sync_requested_at` integer,
	`last_sync_at` integer,
	`last_sync_ok` integer,
	`last_sync_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `schedules` ADD `delivery` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `cloud_synced_at` integer;--> statement-breakpoint
ALTER TABLE `schedules` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `social_account_tokens` ADD `key_version` integer DEFAULT 1 NOT NULL;