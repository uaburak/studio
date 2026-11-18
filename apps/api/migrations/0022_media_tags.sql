CREATE TABLE `asset_analyses` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`tags` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`colors` text NOT NULL,
	`orientation` text,
	`aspect_ratio` real,
	`is_cutout` integer DEFAULT false NOT NULL,
	`is_logo_like` integer DEFAULT false NOT NULL,
	`caption` text,
	`feature_print` text,
	`feature_revision` integer,
	`note` text,
	`helper_version` text,
	`analyzed_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "asset_analyses_status_check" CHECK("asset_analyses"."status" in ('complete', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `asset_analyses_status_idx` ON `asset_analyses` (`status`,`version`);--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `media_captions` integer DEFAULT false NOT NULL;