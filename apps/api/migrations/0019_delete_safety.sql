ALTER TABLE `assets` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `assets_deleted_idx` ON `assets` (`deleted_at`);--> statement-breakpoint
ALTER TABLE `contents` ADD `deleted_at` integer;--> statement-breakpoint
CREATE INDEX `contents_deleted_idx` ON `contents` (`deleted_at`);