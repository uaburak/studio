CREATE TABLE `account_insights` (
	`social_account_id` text NOT NULL,
	`day` text NOT NULL,
	`followers` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`social_account_id`, `day`),
	FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `comment_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`external_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `post_comments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comment_actions_kind_check" CHECK("comment_actions"."kind" in ('reply', 'hide', 'unhide', 'delete')),
	CONSTRAINT "comment_actions_status_check" CHECK("comment_actions"."status" in ('pending', 'sending', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `comment_actions_status_idx` ON `comment_actions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `comment_actions_comment_idx` ON `comment_actions` (`comment_id`);--> statement-breakpoint
CREATE TABLE `engagement_sync` (
	`social_account_id` text PRIMARY KEY NOT NULL,
	`insights_synced_at` integer,
	`comments_synced_at` integer,
	`status` text,
	`error` text,
	`retry_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `insight_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`at` integer NOT NULL,
	`hours_after` real,
	`metrics` text NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `insight_snapshots_schedule_idx` ON `insight_snapshots` (`schedule_id`,`at`);--> statement-breakpoint
CREATE TABLE `post_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`social_account_id` text NOT NULL,
	`platform` text NOT NULL,
	`schedule_id` text,
	`content_id` text,
	`external_post_id` text NOT NULL,
	`external_id` text NOT NULL,
	`parent_id` text,
	`parent_external_id` text,
	`author` text,
	`author_id` text,
	`text` text NOT NULL,
	`like_count` integer,
	`hidden` integer DEFAULT false NOT NULL,
	`own` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`read_at` integer,
	`deleted_at` integer,
	`suggestion` text,
	`suggestion_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "post_comments_platform_check" CHECK("post_comments"."platform" in ('instagram', 'facebook', 'linkedin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_comments_external_unique` ON `post_comments` (`platform`,`external_id`);--> statement-breakpoint
CREATE INDEX `post_comments_brand_idx` ON `post_comments` (`brand_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `post_comments_schedule_idx` ON `post_comments` (`schedule_id`);--> statement-breakpoint
CREATE INDEX `post_comments_content_idx` ON `post_comments` (`content_id`);--> statement-breakpoint
CREATE INDEX `post_comments_parent_idx` ON `post_comments` (`parent_id`);--> statement-breakpoint
CREATE INDEX `post_comments_unread_idx` ON `post_comments` (`brand_id`,`read_at`);--> statement-breakpoint
CREATE TABLE `post_insights` (
	`schedule_id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`content_id` text NOT NULL,
	`social_account_id` text NOT NULL,
	`platform` text NOT NULL,
	`external_post_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`metrics` text DEFAULT '{}' NOT NULL,
	`note` text,
	`error` text,
	`miss_count` integer DEFAULT 0 NOT NULL,
	`synced_at` integer,
	`next_sync_at` integer,
	`comment_count` integer,
	`comments_synced_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "post_insights_status_check" CHECK("post_insights"."status" in ('pending', 'ok', 'partial', 'deleted', 'error'))
);
--> statement-breakpoint
CREATE INDEX `post_insights_brand_idx` ON `post_insights` (`brand_id`);--> statement-breakpoint
CREATE INDEX `post_insights_next_idx` ON `post_insights` (`next_sync_at`);--> statement-breakpoint
CREATE INDEX `post_insights_content_idx` ON `post_insights` (`content_id`);--> statement-breakpoint
CREATE TABLE `publish_locations` (
	`brand_id` text NOT NULL,
	`location_id` text NOT NULL,
	`name` text NOT NULL,
	`source` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`brand_id`, `location_id`),
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "publish_locations_source_check" CHECK("publish_locations"."source" in ('page', 'manual', 'used'))
);
--> statement-breakpoint
ALTER TABLE `contents` ADD `publish_details` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `external_post_id` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `schedules` ADD `publish_warnings` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `details_rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `schedules_published_idx` ON `schedules` (`status`,`published_at`);--> statement-breakpoint
-- Published schedules before 0023: their post id and time from the last successful publish log.
UPDATE `schedules` SET
	`external_post_id` = (SELECT `l`.`external_post_id` FROM `publish_logs` `l` WHERE `l`.`schedule_id` = `schedules`.`id` AND `l`.`status` = 'succeeded' ORDER BY `l`.`attempt` DESC LIMIT 1),
	`published_at` = (SELECT COALESCE(`l`.`finished_at`, `l`.`started_at`) FROM `publish_logs` `l` WHERE `l`.`schedule_id` = `schedules`.`id` AND `l`.`status` = 'succeeded' ORDER BY `l`.`attempt` DESC LIMIT 1)
WHERE `status` = 'published';
--> statement-breakpoint
-- Their statistics rows (read soon; posts older than 90 days stop after the first read).
INSERT OR IGNORE INTO `post_insights` (`schedule_id`, `brand_id`, `content_id`, `social_account_id`, `platform`, `external_post_id`, `status`, `metrics`, `miss_count`, `next_sync_at`, `updated_at`)
SELECT `id`, `brand_id`, `content_id`, `social_account_id`, `platform`, `external_post_id`, 'pending', '{}', 0, COALESCE(`published_at`, `updated_at`) + 3600000, `updated_at`
FROM `schedules` WHERE `status` = 'published' AND `external_post_id` IS NOT NULL AND `platform` IN ('instagram', 'facebook');
