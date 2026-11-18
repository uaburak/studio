CREATE TABLE `content_template_slides` (
	`template_id` text NOT NULL,
	`position` integer NOT NULL,
	`html` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`rendered_asset_id` text,
	`layers` text,
	PRIMARY KEY(`template_id`, `position`),
	FOREIGN KEY (`template_id`) REFERENCES `content_templates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rendered_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "content_template_slides_size_check" CHECK("content_template_slides"."width" > 0 and "content_template_slides"."height" > 0)
);
--> statement-breakpoint
CREATE INDEX `content_template_slides_asset_idx` ON `content_template_slides` (`rendered_asset_id`);--> statement-breakpoint
CREATE TABLE `content_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`content_type` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`slide_count` integer NOT NULL,
	`fields` text NOT NULL,
	`source_content_id` text,
	`source_version` integer NOT NULL,
	`source_title` text DEFAULT '' NOT NULL,
	`document_asset_id` text,
	`document_format` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`document_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "content_templates_kind_check" CHECK("content_templates"."kind" in ('html', 'canvas')),
	CONSTRAINT "content_templates_type_check" CHECK("content_templates"."content_type" in ('post', 'carousel', 'story', 'reel')),
	CONSTRAINT "content_templates_slides_check" CHECK("content_templates"."slide_count" >= 1)
);
--> statement-breakpoint
CREATE INDEX `content_templates_brand_idx` ON `content_templates` (`brand_id`,`id`);--> statement-breakpoint
CREATE INDEX `content_templates_document_idx` ON `content_templates` (`document_asset_id`);--> statement-breakpoint
ALTER TABLE `contents` ADD `template_id` text REFERENCES content_templates(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `contents` ADD `source_content_id` text REFERENCES contents(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `contents` ADD `source_version` integer;--> statement-breakpoint
ALTER TABLE `contents` ADD `source_kind` text;--> statement-breakpoint
CREATE INDEX `contents_source_idx` ON `contents` (`source_content_id`);--> statement-breakpoint
CREATE INDEX `contents_template_idx` ON `contents` (`template_id`);--> statement-breakpoint
ALTER TABLE `plan_items` ADD `template_id` text REFERENCES content_templates(id) ON UPDATE no action ON DELETE set null;