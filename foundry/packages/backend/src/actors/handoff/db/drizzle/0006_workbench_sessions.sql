CREATE TABLE `handoff_workbench_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`session_name` text NOT NULL,
	`model` text NOT NULL,
	`unread` integer DEFAULT 0 NOT NULL,
	`draft_text` text DEFAULT '' NOT NULL,
	`draft_attachments_json` text DEFAULT '[]' NOT NULL,
	`draft_updated_at` integer,
	`created` integer DEFAULT 1 NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL,
	`thinking_since_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
