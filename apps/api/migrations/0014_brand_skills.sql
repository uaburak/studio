CREATE TABLE `brand_skill_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`brand_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`job_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `brand_skills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "brand_skill_versions_origin_check" CHECK("brand_skill_versions"."origin" in ('manual', 'ai_draft', 'restore'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_skill_versions_skill_version_idx` ON `brand_skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE `brand_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`origin` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "brand_skills_origin_check" CHECK("brand_skills"."origin" in ('manual', 'ai_draft', 'restore'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brand_skills_brand_name_idx` ON `brand_skills` (`brand_id`,`name`);--> statement-breakpoint
CREATE INDEX `brand_skills_brand_idx` ON `brand_skills` (`brand_id`,`id`);