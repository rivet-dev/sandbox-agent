import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  handoffId: text("handoff_id"),
  branchName: text("branch_name"),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at").notNull(),
});
