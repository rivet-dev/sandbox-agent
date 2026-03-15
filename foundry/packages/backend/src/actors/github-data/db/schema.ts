import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

export const githubMeta = sqliteTable("github_meta", {
  id: integer("id").primaryKey(),
  connectedAccount: text("connected_account").notNull(),
  installationStatus: text("installation_status").notNull(),
  syncStatus: text("sync_status").notNull(),
  installationId: integer("installation_id"),
  lastSyncLabel: text("last_sync_label").notNull(),
  lastSyncAt: integer("last_sync_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const githubRepositories = sqliteTable("github_repositories", {
  repoId: text("repo_id").notNull().primaryKey(),
  fullName: text("full_name").notNull(),
  cloneUrl: text("clone_url").notNull(),
  private: integer("private").notNull(),
  defaultBranch: text("default_branch").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const githubBranches = sqliteTable("github_branches", {
  branchId: text("branch_id").notNull().primaryKey(),
  repoId: text("repo_id").notNull(),
  branchName: text("branch_name").notNull(),
  commitSha: text("commit_sha").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const githubMembers = sqliteTable("github_members", {
  memberId: text("member_id").notNull().primaryKey(),
  login: text("login").notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  role: text("role"),
  state: text("state").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const githubPullRequests = sqliteTable("github_pull_requests", {
  prId: text("pr_id").notNull().primaryKey(),
  repoId: text("repo_id").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  state: text("state").notNull(),
  url: text("url").notNull(),
  headRefName: text("head_ref_name").notNull(),
  baseRefName: text("base_ref_name").notNull(),
  authorLogin: text("author_login"),
  isDraft: integer("is_draft").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
