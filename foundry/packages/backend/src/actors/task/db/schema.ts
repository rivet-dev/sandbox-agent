import { check, integer, sqliteTable, text } from "rivetkit/db/drizzle";
import { sql } from "drizzle-orm";

// SQLite is per task actor instance, so these tables only ever store one row (id=1).
export const task = sqliteTable(
  "task",
  {
    id: integer("id").primaryKey(),
    branchName: text("branch_name"),
    title: text("title"),
    task: text("task").notNull(),
    sandboxProviderId: text("sandbox_provider_id").notNull(),
    status: text("status").notNull(),
    agentType: text("agent_type").default("claude"),
    prSubmitted: integer("pr_submitted").default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("task_singleton_id_check", sql`${table.id} = 1`)],
);

export const taskRuntime = sqliteTable(
  "task_runtime",
  {
    id: integer("id").primaryKey(),
    activeSandboxId: text("active_sandbox_id"),
    activeSessionId: text("active_session_id"),
    activeSwitchTarget: text("active_switch_target"),
    activeCwd: text("active_cwd"),
    statusMessage: text("status_message"),
    gitStateJson: text("git_state_json"),
    gitStateUpdatedAt: integer("git_state_updated_at"),
    provisionStage: text("provision_stage"),
    provisionStageUpdatedAt: integer("provision_stage_updated_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [check("task_runtime_singleton_id_check", sql`${table.id} = 1`)],
);

/**
 * Coordinator index of SandboxInstanceActor instances.
 * Tracks all sandbox instances provisioned for this task. Only one
 * is active at a time (referenced by taskRuntime.activeSandboxId).
 */
export const taskSandboxes = sqliteTable("task_sandboxes", {
  sandboxId: text("sandbox_id").notNull().primaryKey(),
  sandboxProviderId: text("sandbox_provider_id").notNull(),
  sandboxActorId: text("sandbox_actor_id"),
  switchTarget: text("switch_target").notNull(),
  cwd: text("cwd"),
  statusMessage: text("status_message"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/**
 * Coordinator index of workbench sessions within this task.
 * The task actor is the coordinator for sessions. Each row holds session
 * metadata, model, status, transcript, and draft state. Sessions are
 * sub-entities of the task — no separate session actor in the DB.
 */
export const taskWorkbenchSessions = sqliteTable("task_workbench_sessions", {
  sessionId: text("session_id").notNull().primaryKey(),
  sandboxSessionId: text("sandbox_session_id"),
  sessionName: text("session_name").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull().default("ready"),
  errorMessage: text("error_message"),
  transcriptJson: text("transcript_json").notNull().default("[]"),
  transcriptUpdatedAt: integer("transcript_updated_at"),
  unread: integer("unread").notNull().default(0),
  draftText: text("draft_text").notNull().default(""),
  // Structured by the workbench composer attachment payload format.
  draftAttachmentsJson: text("draft_attachments_json").notNull().default("[]"),
  draftUpdatedAt: integer("draft_updated_at"),
  created: integer("created").notNull().default(1),
  closed: integer("closed").notNull().default(0),
  thinkingSinceMs: integer("thinking_since_ms"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
