CREATE TABLE `sandbox_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`agent_session_id` text NOT NULL,
	`last_connection_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`destroyed_at` integer,
	`session_init_json` text
);
--> statement-breakpoint

CREATE TABLE `sandbox_session_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`event_index` integer NOT NULL,
	`created_at` integer NOT NULL,
	`connection_id` text NOT NULL,
	`sender` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint

CREATE INDEX `sandbox_sessions_created_at_idx` ON `sandbox_sessions` (`created_at`);
--> statement-breakpoint
CREATE INDEX `sandbox_session_events_session_id_event_index_idx` ON `sandbox_session_events` (`session_id`,`event_index`);
--> statement-breakpoint
CREATE INDEX `sandbox_session_events_session_id_created_at_idx` ON `sandbox_session_events` (`session_id`,`created_at`);
