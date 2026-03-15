CREATE TABLE `repo_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`remote_url` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_index` (
	`task_id` text PRIMARY KEY NOT NULL,
	`branch_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
