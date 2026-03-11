-- Fix: make branch_name/title nullable during initial "naming" stage.
-- 0003 was missing statement breakpoints, so drizzle's migrator marked it applied without executing all statements.
-- Rebuild the table again with proper statement breakpoints.

PRAGMA foreign_keys=off;
--> statement-breakpoint

DROP TABLE IF EXISTS `handoff__new`;
--> statement-breakpoint

CREATE TABLE `handoff__new` (
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
--> statement-breakpoint

INSERT INTO `handoff__new` (
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
FROM `handoff`;
--> statement-breakpoint

DROP TABLE `handoff`;
--> statement-breakpoint

ALTER TABLE `handoff__new` RENAME TO `handoff`;
--> statement-breakpoint

PRAGMA foreign_keys=on;
