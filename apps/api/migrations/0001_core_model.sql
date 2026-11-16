CREATE TABLE `assets` (
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
	CONSTRAINT "assets_kind_check" CHECK("assets"."kind" in ('image', 'video', 'audio', 'font', 'logo', 'other')),
	CONSTRAINT "assets_source_check" CHECK("assets"."source" in ('upload', 'generated', 'ingested')),
	CONSTRAINT "assets_bytes_check" CHECK("assets"."bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_object_key_unique` ON `assets` (`object_key`);--> statement-breakpoint
CREATE INDEX `assets_brand_idx` ON `assets` (`brand_id`,`id`);--> statement-breakpoint
CREATE INDEX `assets_brand_kind_idx` ON `assets` (`brand_id`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `assets_sha256_idx` ON `assets` (`sha256`);--> statement-breakpoint
CREATE TABLE `brand_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`tokens` text NOT NULL,
	`design_rules` text DEFAULT '' NOT NULL,
	`voice` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approved_at` integer,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "brand_profiles_status_check" CHECK("brand_profiles"."status" in ('draft', 'approved')),
	CONSTRAINT "brand_profiles_current_is_approved" CHECK("brand_profiles"."is_current" = 0 or "brand_profiles"."status" = 'approved'),
	CONSTRAINT "brand_profiles_version_positive" CHECK("brand_profiles"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_profiles_brand_version_unique` ON `brand_profiles` (`brand_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `brand_profiles_current_unique` ON `brand_profiles` (`brand_id`) WHERE "brand_profiles"."is_current" = 1;--> statement-breakpoint
CREATE TABLE `brands` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`default_language` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "brands_status_check" CHECK("brands"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brands_slug_unique` ON `brands` (`slug`);--> statement-breakpoint
CREATE INDEX `brands_status_idx` ON `brands` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `content_version_slides` (
	`version_id` text NOT NULL,
	`position` integer NOT NULL,
	`html` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`rendered_asset_id` text,
	PRIMARY KEY(`version_id`, `position`),
	FOREIGN KEY (`version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rendered_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "content_version_slides_size_check" CHECK("content_version_slides"."width" > 0 and "content_version_slides"."height" > 0)
);
--> statement-breakpoint
CREATE INDEX `content_version_slides_asset_idx` ON `content_version_slides` (`rendered_asset_id`);--> statement-breakpoint
CREATE TABLE `content_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`content_id` text NOT NULL,
	`version` integer NOT NULL,
	`origin` text NOT NULL,
	`content_hash` text NOT NULL,
	`slide_count` integer NOT NULL,
	`note` text,
	`job_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content_versions_origin_check" CHECK("content_versions"."origin" in ('generated', 'manual_edit', 'ai_edit')),
	CONSTRAINT "content_versions_version_positive" CHECK("content_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_versions_content_version_unique` ON `content_versions` (`content_id`,`version`);--> statement-breakpoint
CREATE TABLE `contents` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`target_platforms` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`current_version_id` text,
	`approved_version_id` text,
	`approved_hash` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`current_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "contents_type_check" CHECK("contents"."type" in ('post', 'carousel', 'story', 'reel')),
	CONSTRAINT "contents_status_check" CHECK("contents"."status" in ('draft', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'failed')),
	CONSTRAINT "contents_approval_complete" CHECK(("contents"."approved_version_id" is null) = ("contents"."approved_hash" is null))
);
--> statement-breakpoint
CREATE INDEX `contents_brand_idx` ON `contents` (`brand_id`,`id`);--> statement-breakpoint
CREATE INDEX `contents_brand_status_idx` ON `contents` (`brand_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `contents_status_idx` ON `contents` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`brand_id` text,
	`content_id` text,
	`payload` text NOT NULL,
	`output` text,
	`error` text,
	`progress` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "jobs_progress_range" CHECK("jobs"."progress" is null or ("jobs"."progress" >= 0 and "jobs"."progress" <= 1))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_brand_idx` ON `jobs` (`brand_id`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_content_idx` ON `jobs` (`content_id`,`id`);--> statement-breakpoint
CREATE TABLE `publish_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`external_post_id` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "publish_logs_status_check" CHECK("publish_logs"."status" in ('started', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_logs_schedule_attempt_unique` ON `publish_logs` (`schedule_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`content_id` text NOT NULL,
	`brand_id` text NOT NULL,
	`platform` text NOT NULL,
	`social_account_id` text NOT NULL,
	`version_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`social_account_id`) REFERENCES `social_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "schedules_platform_check" CHECK("schedules"."platform" in ('instagram', 'facebook', 'linkedin')),
	CONSTRAINT "schedules_status_check" CHECK("schedules"."status" in ('pending', 'publishing', 'published', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `schedules_status_time_idx` ON `schedules` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `schedules_brand_time_idx` ON `schedules` (`brand_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `schedules_content_idx` ON `schedules` (`content_id`);--> statement-breakpoint
CREATE INDEX `schedules_account_idx` ON `schedules` (`social_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_active_unique` ON `schedules` (`content_id`,`social_account_id`) WHERE "schedules"."status" in ('pending', 'publishing');--> statement-breakpoint
CREATE TABLE `social_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`platform` text NOT NULL,
	`handle` text NOT NULL,
	`external_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "social_accounts_platform_check" CHECK("social_accounts"."platform" in ('instagram', 'facebook', 'linkedin')),
	CONSTRAINT "social_accounts_status_check" CHECK("social_accounts"."status" in ('pending', 'connected', 'needs_reauth', 'disabled'))
);
--> statement-breakpoint
CREATE INDEX `social_accounts_brand_idx` ON `social_accounts` (`brand_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `social_accounts_external_unique` ON `social_accounts` (`platform`,`external_id`);