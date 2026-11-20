CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`content_id` text,
	`product_id` text,
	`conversation_id` text,
	`message_id` text,
	`kind` text NOT NULL,
	`asset_ids` text NOT NULL,
	`check_report` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`slot_id` text,
	`replaces_asset_id` text,
	`approved_asset_id` text,
	`source_job_id` text,
	`regenerate_job_id` text,
	`request` text,
	`decision_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "approval_requests_kind_check" CHECK("approval_requests"."kind" in ('product_image', 'variant', 'product_photo_upgrade')),
	CONSTRAINT "approval_requests_status_check" CHECK("approval_requests"."status" in ('pending', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX `approval_requests_brand_status_idx` ON `approval_requests` (`brand_id`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `approval_requests_content_status_idx` ON `approval_requests` (`content_id`,`status`);--> statement-breakpoint
CREATE INDEX `approval_requests_conversation_idx` ON `approval_requests` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `approval_requests_status_idx` ON `approval_requests` (`status`,`id`);--> statement-breakpoint
ALTER TABLE `brands` ADD `default_engine` text;--> statement-breakpoint
ALTER TABLE `brands` ADD `image_style_preset` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `entity_mentions` text;