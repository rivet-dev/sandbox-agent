import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

// SQLite is per repository actor instance (organizationId+repoId).

export const repoMeta = sqliteTable("repo_meta", {
  id: integer("id").primaryKey(),
  remoteUrl: text("remote_url").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Coordinator index of TaskActor instances.
 * The repository actor is the coordinator for tasks. Each row maps a
 * taskId to its branch name. Used for branch conflict checking and
 * task-by-branch lookups. Rows are inserted at task creation and
 * updated on branch rename.
 */
export const taskIndex = sqliteTable("task_index", {
  taskId: text("task_id").notNull().primaryKey(),
  branchName: text("branch_name"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
