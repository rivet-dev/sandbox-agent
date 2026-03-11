CREATE TABLE `provider_profiles` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`profile_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
