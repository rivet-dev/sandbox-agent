-- Allow tasks to exist before their branch/title are determined.
-- Drizzle doesn't support altering column nullability in SQLite directly, so rebuild the table.

PRAGMA foreign_keys=off;

CREATE TABLE `task__new` (
	`id` integer PRIMARY KEY NOT NULL,
	`branch_name` text,
	`title` text,
	`task` text NOT NULL,
	`provider_id` text NOT NULL,
	`status` text NOT NULL,
	`agent_type` text DEFAULT 'claude',
	`pr_submitted` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);

INSERT INTO `task__new` (
  `id`,
  `branch_name`,
  `title`,
  `task`,
  `provider_id`,
  `status`,
  `agent_type`,
  `pr_submitted`,
  `created_at`,
  `updated_at`
)
SELECT
  `id`,
  `branch_name`,
  `title`,
  `task`,
  `provider_id`,
  `status`,
  `agent_type`,
  `pr_submitted`,
  `created_at`,
  `updated_at`
FROM `task`;

DROP TABLE `task`;
ALTER TABLE `task__new` RENAME TO `task`;

PRAGMA foreign_keys=on;

