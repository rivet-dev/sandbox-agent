const journal = {
  entries: [
    {
      idx: 0,
      when: 1773446400000,
      tag: "0000_github_data",
      breakpoints: true,
    },
    {
      idx: 1,
      when: 1773810002000,
      tag: "0001_default_branch",
      breakpoints: true,
    },
    {
      idx: 2,
      when: 1773810300000,
      tag: "0002_github_branches",
      breakpoints: true,
    },
  ],
} as const;

export default {
  journal,
  migrations: {
    m0000: `CREATE TABLE \`github_meta\` (
	\`id\` integer PRIMARY KEY NOT NULL,
	\`connected_account\` text NOT NULL,
	\`installation_status\` text NOT NULL,
	\`sync_status\` text NOT NULL,
	\`installation_id\` integer,
	\`last_sync_label\` text NOT NULL,
	\`last_sync_at\` integer,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`github_repositories\` (
	\`repo_id\` text PRIMARY KEY NOT NULL,
	\`full_name\` text NOT NULL,
	\`clone_url\` text NOT NULL,
	\`private\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`github_members\` (
	\`member_id\` text PRIMARY KEY NOT NULL,
	\`login\` text NOT NULL,
	\`display_name\` text NOT NULL,
	\`email\` text,
	\`role\` text,
	\`state\` text NOT NULL,
	\`updated_at\` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`github_pull_requests\` (
	\`pr_id\` text PRIMARY KEY NOT NULL,
	\`repo_id\` text NOT NULL,
	\`repo_full_name\` text NOT NULL,
	\`number\` integer NOT NULL,
	\`title\` text NOT NULL,
	\`body\` text,
	\`state\` text NOT NULL,
	\`url\` text NOT NULL,
	\`head_ref_name\` text NOT NULL,
	\`base_ref_name\` text NOT NULL,
	\`author_login\` text,
	\`is_draft\` integer NOT NULL,
	\`updated_at\` integer NOT NULL
);
`,
    m0001: `ALTER TABLE \`github_repositories\` ADD \`default_branch\` text NOT NULL DEFAULT 'main';
`,
    m0002: `CREATE TABLE \`github_branches\` (
	\`branch_id\` text PRIMARY KEY NOT NULL,
	\`repo_id\` text NOT NULL,
	\`branch_name\` text NOT NULL,
	\`commit_sha\` text NOT NULL,
	\`updated_at\` integer NOT NULL
);
`,
  } as const,
};
