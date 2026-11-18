CREATE TABLE `brand_products` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`image_asset_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `brand_products_brand_idx` ON `brand_products` (`brand_id`,`id`);