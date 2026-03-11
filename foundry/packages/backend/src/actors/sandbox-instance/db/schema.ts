import { integer, sqliteTable, text } from "rivetkit/db/drizzle";

// SQLite is per sandbox-instance actor instance.
export const sandboxInstance = sqliteTable("sandbox_instance", {
  id: integer("id").primaryKey(),
  metadataJson: text("metadata_json").notNull(),
  status: text("status").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Persist sandbox-agent sessions/events in SQLite instead of actor state so they survive
// serverless actor evictions and backend restarts.
export const sandboxSessions = sqliteTable("sandbox_sessions", {
  id: text("id").notNull().primaryKey(),
  agent: text("agent").notNull(),
  agentSessionId: text("agent_session_id").notNull(),
  lastConnectionId: text("last_connection_id").notNull(),
  createdAt: integer("created_at").notNull(),
  destroyedAt: integer("destroyed_at"),
  sessionInitJson: text("session_init_json"),
});

export const sandboxSessionEvents = sqliteTable("sandbox_session_events", {
  id: text("id").notNull().primaryKey(),
  sessionId: text("session_id").notNull(),
  eventIndex: integer("event_index").notNull(),
  createdAt: integer("created_at").notNull(),
  connectionId: text("connection_id").notNull(),
  sender: text("sender").notNull(),
  payloadJson: text("payload_json").notNull(),
});
