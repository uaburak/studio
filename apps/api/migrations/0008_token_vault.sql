CREATE TABLE `social_account_tokens` (
	`social_account_id` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`iv` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`expires_at` integer,
	`health` text DEFAULT 'valid' NOT NULL,
	`checked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "social_account_tokens_health_check" CHECK("social_account_tokens"."health" in ('valid', 'expiring_soon', 'invalid', 'missing_scopes', 'unchecked'))
);
--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`object_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`original_filename` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assets_kind_check" CHECK("__new_assets"."kind" in ('image', 'video', 'audio', 'document', 'font', 'logo', 'other')),
	CONSTRAINT "assets_source_check" CHECK("__new_assets"."source" in ('upload', 'generated', 'ingested')),
	CONSTRAINT "assets_bytes_check" CHECK("__new_assets"."bytes" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_assets`("id", "brand_id", "kind", "source", "object_key", "mime_type", "bytes", "sha256", "width", "height", "duration_ms", "original_filename", "created_at") SELECT "id", "brand_id", "kind", "source", "object_key", "mime_type", "bytes", "sha256", "width", "height", "duration_ms", "original_filename", "created_at" FROM `assets`;--> statement-breakpoint
DROP TABLE `assets`;--> statement-breakpoint
ALTER TABLE `__new_assets` RENAME TO `assets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `assets_object_key_unique` ON `assets` (`object_key`);--> statement-breakpoint
CREATE INDEX `assets_brand_idx` ON `assets` (`brand_id`,`id`);--> statement-breakpoint
CREATE INDEX `assets_brand_kind_idx` ON `assets` (`brand_id`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `assets_sha256_idx` ON `assets` (`sha256`);--> statement-breakpoint
ALTER TABLE `publish_logs` ADD `permalink` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `permalink` text;