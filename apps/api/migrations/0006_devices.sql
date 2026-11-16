CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text DEFAULT 'other' NOT NULL,
	`token_hash` text NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "devices_platform_check" CHECK("devices"."platform" in ('ios', 'ipados', 'macos', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_idx` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`device_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pairing_codes_hash_idx` ON `pairing_codes` (`code_hash`);--> statement-breakpoint
CREATE TABLE `pairing_failures` (
	`id` text PRIMARY KEY NOT NULL,
	`client_ip` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pairing_failures_time_idx` ON `pairing_failures` (`created_at`);--> statement-breakpoint
CREATE INDEX `pairing_failures_client_idx` ON `pairing_failures` (`client_ip`,`created_at`);