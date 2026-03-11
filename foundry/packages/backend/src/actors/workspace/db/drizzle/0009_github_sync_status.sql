ALTER TABLE `organization_profile` ADD COLUMN `github_sync_status` text NOT NULL DEFAULT 'pending';
ALTER TABLE `organization_profile` ADD COLUMN `github_last_sync_at` integer;
UPDATE `organization_profile`
SET `github_sync_status` = CASE
  WHEN `repo_import_status` = 'ready' THEN 'synced'
  WHEN `repo_import_status` = 'importing' THEN 'syncing'
  ELSE 'pending'
END;
