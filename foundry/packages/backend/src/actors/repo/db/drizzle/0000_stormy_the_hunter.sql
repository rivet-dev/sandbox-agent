CREATE TABLE `branches` (
	`branch_name` text PRIMARY KEY NOT NULL,
	`commit_sha` text NOT NULL,
	`worktree_path` text,
	`parent_branch` text,
	`diff_stat` text,
	`has_unpushed` integer,
	`conflicts_with_main` integer,
	`first_seen_at` integer,
	`last_seen_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pr_cache` (
	`branch_name` text PRIMARY KEY NOT NULL,
	`pr_number` integer NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`pr_url` text,
	`pr_author` text,
	`is_draft` integer,
	`ci_status` text,
	`review_status` text,
	`reviewer` text,
	`fetched_at` integer,
	`updated_at` integer NOT NULL
);
