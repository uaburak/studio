ALTER TABLE `ai_settings` ADD `claude_limit_mode` text;--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `stop_at_budget` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `limit_choice` text;--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `limit_until` integer;--> statement-breakpoint
ALTER TABLE `ai_settings` ADD `limit_decided_at` integer;