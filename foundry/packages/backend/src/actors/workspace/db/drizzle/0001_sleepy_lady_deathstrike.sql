CREATE TABLE `repos` (
	`repo_id` text PRIMARY KEY NOT NULL,
	`remote_url` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
