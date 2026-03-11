import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

// SQLite is per task actor instance, so these tables only ever store one row (id=1).
export const task = sqliteTable("task", {
  id: integer("id").primaryKey(),
  branchName: text("branch_name"),
  title: text("title"),
  task: text("task").notNull(),
  providerId: text("provider_id").notNull(),
  status: text("status").notNull(),
  agentType: text("agent_type").default("claude"),
  prSubmitted: integer("pr_submitted").default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const taskRuntime = sqliteTable("task_runtime", {
  id: integer("id").primaryKey(),
  activeSandboxId: text("active_sandbox_id"),
  activeSessionId: text("active_session_id"),
  activeSwitchTarget: text("active_switch_target"),
  activeCwd: text("active_cwd"),
  statusMessage: text("status_message"),
  updatedAt: integer("updated_at").notNull(),
});

export const taskSandboxes = sqliteTable("task_sandboxes", {
  sandboxId: text("sandbox_id").notNull().primaryKey(),
  providerId: text("provider_id").notNull(),
  sandboxActorId: text("sandbox_actor_id"),
  switchTarget: text("switch_target").notNull(),
  cwd: text("cwd"),
  statusMessage: text("status_message"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const taskWorkbenchSessions = sqliteTable("task_workbench_sessions", {
  sessionId: text("session_id").notNull().primaryKey(),
  sessionName: text("session_name").notNull(),
  model: text("model").notNull(),
  unread: integer("unread").notNull().default(0),
  draftText: text("draft_text").notNull().default(""),
  draftAttachmentsJson: text("draft_attachments_json").notNull().default("[]"),
  draftUpdatedAt: integer("draft_updated_at"),
  created: integer("created").notNull().default(1),
  closed: integer("closed").notNull().default(0),
  thinkingSinceMs: integer("thinking_since_ms"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
