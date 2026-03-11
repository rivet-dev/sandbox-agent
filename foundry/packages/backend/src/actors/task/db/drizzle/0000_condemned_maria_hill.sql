CREATE TABLE `handoff` (
	`id` integer PRIMARY KEY NOT NULL,
	`branch_name` text NOT NULL,
	`title` text NOT NULL,
	`task` text NOT NULL,
	`provider_id` text NOT NULL,
	`status` text NOT NULL,
	`agent_type` text DEFAULT 'claude',
	`auto_committed` integer DEFAULT 0,
	`pushed` integer DEFAULT 0,
	`pr_submitted` integer DEFAULT 0,
	`needs_push` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `handoff_runtime` (
	`id` integer PRIMARY KEY NOT NULL,
	`sandbox_id` text,
	`session_id` text,
	`switch_target` text,
	`status_message` text,
	`updated_at` integer NOT NULL
);
