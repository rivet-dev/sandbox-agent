ALTER TABLE `handoff_runtime` RENAME COLUMN "sandbox_id" TO "active_sandbox_id";--> statement-breakpoint
ALTER TABLE `handoff_runtime` RENAME COLUMN "session_id" TO "active_session_id";--> statement-breakpoint
ALTER TABLE `handoff_runtime` RENAME COLUMN "switch_target" TO "active_switch_target";--> statement-breakpoint
CREATE TABLE `handoff_sandboxes` (
	`sandbox_id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`switch_target` text NOT NULL,
	`cwd` text,
	`status_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `handoff_runtime` ADD `active_cwd` text;
--> statement-breakpoint
INSERT INTO `handoff_sandboxes` (
  `sandbox_id`,
  `provider_id`,
  `switch_target`,
  `cwd`,
  `status_message`,
  `created_at`,
  `updated_at`
)
SELECT
  r.`active_sandbox_id`,
  (SELECT h.`provider_id` FROM `handoff` h WHERE h.`id` = 1),
  r.`active_switch_target`,
  r.`active_cwd`,
  r.`status_message`,
  COALESCE((SELECT h.`created_at` FROM `handoff` h WHERE h.`id` = 1), r.`updated_at`),
  r.`updated_at`
FROM `handoff_runtime` r
WHERE
  r.`id` = 1
  AND r.`active_sandbox_id` IS NOT NULL
  AND r.`active_switch_target` IS NOT NULL
ON CONFLICT(`sandbox_id`) DO NOTHING;
