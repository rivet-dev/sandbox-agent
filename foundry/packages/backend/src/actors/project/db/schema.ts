import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

// SQLite is per project actor instance (workspaceId+repoId), so no workspaceId/repoId columns needed.

export const branches = sqliteTable("branches", {
  branchName: text("branch_name").notNull().primaryKey(),
  commitSha: text("commit_sha").notNull(),
  parentBranch: text("parent_branch"),
  trackedInStack: integer("tracked_in_stack"),
  diffStat: text("diff_stat"),
  hasUnpushed: integer("has_unpushed"),
  conflictsWithMain: integer("conflicts_with_main"),
  firstSeenAt: integer("first_seen_at"),
  lastSeenAt: integer("last_seen_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const repoMeta = sqliteTable("repo_meta", {
  id: integer("id").primaryKey(),
  remoteUrl: text("remote_url").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const prCache = sqliteTable("pr_cache", {
  branchName: text("branch_name").notNull().primaryKey(),
  prNumber: integer("pr_number").notNull(),
  state: text("state").notNull(),
  title: text("title").notNull(),
  prUrl: text("pr_url"),
  prAuthor: text("pr_author"),
  isDraft: integer("is_draft"),
  ciStatus: text("ci_status"),
  reviewStatus: text("review_status"),
  reviewer: text("reviewer"),
  fetchedAt: integer("fetched_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const taskIndex = sqliteTable("task_index", {
  taskId: text("task_id").notNull().primaryKey(),
  branchName: text("branch_name"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
