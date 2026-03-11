CREATE TABLE `handoff_index` (
	`handoff_id` text PRIMARY KEY NOT NULL,
	`branch_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
