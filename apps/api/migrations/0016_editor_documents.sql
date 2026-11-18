CREATE TABLE `content_version_documents` (
	`version_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`asset_id` text NOT NULL,
	`format` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "content_version_documents_kind_check" CHECK("content_version_documents"."kind" in ('wecra')),
	CONSTRAINT "content_version_documents_format_check" CHECK("content_version_documents"."format" >= 1)
);
--> statement-breakpoint
CREATE INDEX `content_version_documents_asset_idx` ON `content_version_documents` (`asset_id`);