CREATE TABLE `conversation_alias_names` (
	`conversation_id` text NOT NULL,
	`name` text NOT NULL,
	`alias_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `name`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`alias_id`) REFERENCES `conversation_aliases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_alias_names_alias_idx` ON `conversation_alias_names` (`alias_id`);--> statement-breakpoint
CREATE TABLE `conversation_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`alias` text NOT NULL,
	`message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversation_aliases_alias_check" CHECK(length("conversation_aliases"."alias") between 1 and 40 and "conversation_aliases"."alias" = lower("conversation_aliases"."alias"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_aliases_name_unique` ON `conversation_aliases` (`conversation_id`,`alias`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_aliases_asset_unique` ON `conversation_aliases` (`conversation_id`,`asset_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `mentions` text;