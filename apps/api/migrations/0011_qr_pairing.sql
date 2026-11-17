ALTER TABLE `pairing_codes` ADD `secret_hash` text;--> statement-breakpoint
ALTER TABLE `pairing_codes` ADD `secret_expires_at` integer;--> statement-breakpoint
CREATE INDEX `pairing_codes_secret_idx` ON `pairing_codes` (`secret_hash`);