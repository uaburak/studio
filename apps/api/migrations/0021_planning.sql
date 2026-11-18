CREATE TABLE `brand_planning_settings` (
	`brand_id` text PRIMARY KEY NOT NULL,
	`sector_tags` text DEFAULT '[]' NOT NULL,
	`disabled_categories` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `plan_items` ADD `hook` text;--> statement-breakpoint
ALTER TABLE `plan_items` ADD `similar` text;