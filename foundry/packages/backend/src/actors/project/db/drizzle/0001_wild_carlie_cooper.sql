CREATE TABLE `repo_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`remote_url` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `branches` DROP COLUMN `worktree_path`;