ALTER TABLE `publishing_settings` ADD `max_lateness_minutes` integer;--> statement-breakpoint
ALTER TABLE `schedules` ADD `publish_state` text;--> statement-breakpoint
ALTER TABLE `schedules` ADD `claimed_at` integer;