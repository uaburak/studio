CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`trigger_message_id` text NOT NULL,
	`job_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`model` text,
	`usage` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trigger_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_runs_status_check" CHECK("agent_runs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_runs_attempt_check" CHECK("agent_runs"."attempt" >= 0)
);
--> statement-breakpoint
CREATE INDEX `agent_runs_conversation_idx` ON `agent_runs` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `agent_runs_job_idx` ON `agent_runs` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_active_unique` ON `agent_runs` (`conversation_id`) WHERE "agent_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE TABLE `content_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text NOT NULL,
	`conversation_id` text,
	`run_id` text,
	`title` text DEFAULT '' NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`status` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`decided_at` integer,
	`rejection_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "content_plans_status_check" CHECK("content_plans"."status" in ('draft', 'proposed', 'accepted', 'rejected', 'superseded')),
	CONSTRAINT "content_plans_period_check" CHECK("content_plans"."period_start" <= "content_plans"."period_end"),
	CONSTRAINT "content_plans_revision_check" CHECK("content_plans"."revision" >= 1)
);
--> statement-breakpoint
CREATE INDEX `content_plans_conversation_idx` ON `content_plans` (`conversation_id`,`id`);--> statement-breakpoint
CREATE INDEX `content_plans_brand_idx` ON `content_plans` (`brand_id`,`id`);--> statement-breakpoint
CREATE INDEX `content_plans_status_idx` ON `content_plans` (`status`,`id`);--> statement-breakpoint
CREATE TABLE `conversation_events` (
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `seq`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_events_seq_check" CHECK("conversation_events"."seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`brand_id` text,
	`title` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`last_activity_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`brand_id`) REFERENCES `brands`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "conversations_status_check" CHECK("conversations"."status" in ('active', 'archived')),
	CONSTRAINT "conversations_last_seq_check" CHECK("conversations"."last_seq" >= 0)
);
--> statement-breakpoint
CREATE INDEX `conversations_activity_idx` ON `conversations` (`last_activity_at`,`id`);--> statement-breakpoint
CREATE INDEX `conversations_brand_activity_idx` ON `conversations` (`brand_id`,`last_activity_at`,`id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`parts` text NOT NULL,
	`delta_seqs` text NOT NULL,
	`client_message_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "messages_role_check" CHECK("messages"."role" in ('user', 'assistant', 'system')),
	CONSTRAINT "messages_status_check" CHECK("messages"."status" in ('streaming', 'complete', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_id_unique` ON `messages` (`conversation_id`,`client_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_run_assistant_unique` ON `messages` (`run_id`) WHERE "messages"."role" = 'assistant';--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`position` integer NOT NULL,
	`date` text,
	`platforms` text NOT NULL,
	`content_type` text NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`pillar` text,
	`image_slot` text DEFAULT 'none' NOT NULL,
	`image_brief` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`content_id` text,
	`generation_job_id` text,
	`generation_status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`plan_id`) REFERENCES `content_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`generation_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "plan_items_type_check" CHECK("plan_items"."content_type" in ('post', 'carousel', 'story', 'reel')),
	CONSTRAINT "plan_items_slot_check" CHECK("plan_items"."image_slot" in ('none', 'user_upload', 'ai_generate')),
	CONSTRAINT "plan_items_status_check" CHECK("plan_items"."status" in ('planned', 'accepted', 'skipped')),
	CONSTRAINT "plan_items_position_check" CHECK("plan_items"."position" >= 0)
);
--> statement-breakpoint
CREATE INDEX `plan_items_plan_idx` ON `plan_items` (`plan_id`,`position`);--> statement-breakpoint
CREATE INDEX `plan_items_content_idx` ON `plan_items` (`content_id`);--> statement-breakpoint
CREATE INDEX `plan_items_job_idx` ON `plan_items` (`generation_job_id`);