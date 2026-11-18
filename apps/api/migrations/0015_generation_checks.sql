CREATE TABLE `brand_check_settings` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`disabled_checks` text DEFAULT '[]' NOT NULL,
	`banned_words` text DEFAULT '[]' NOT NULL,
	`strictness` text DEFAULT 'standard' NOT NULL,
	`auto_fix` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "brand_check_settings_strictness_check" CHECK("brand_check_settings"."strictness" in ('relaxed', 'standard', 'strict'))
);
--> statement-breakpoint
CREATE TABLE `content_check_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`content_id` text NOT NULL,
	`brand_id` text NOT NULL,
	`version` integer NOT NULL,
	`version_id` text,
	`trigger` text NOT NULL,
	`job_id` text,
	`strictness` text DEFAULT 'standard' NOT NULL,
	`summary` text NOT NULL,
	`blocking` integer DEFAULT 0 NOT NULL,
	`results` text NOT NULL,
	`model` text,
	`from_version` integer,
	`fixed_version` integer,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "content_check_runs_trigger_check" CHECK("content_check_runs"."trigger" in ('generate', 'render', 'manual', 'fix')),
	CONSTRAINT "content_check_runs_strictness_check" CHECK("content_check_runs"."strictness" in ('relaxed', 'standard', 'strict')),
	CONSTRAINT "content_check_runs_version_positive" CHECK("content_check_runs"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `content_check_runs_content_idx` ON `content_check_runs` (`content_id`,`version`,`id`);