import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  taskId: text("task_id"),
  branchName: text("branch_name"),
  kind: text("kind").notNull(),
  // Structured by the history event kind definitions in application code.
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});
