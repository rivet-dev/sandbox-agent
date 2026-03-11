CREATE TABLE `sandbox_instance` (
	`id` integer PRIMARY KEY NOT NULL,
	`metadata_json` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL
);
