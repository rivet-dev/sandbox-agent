import { and, asc, count, eq } from "drizzle-orm";
import type { ListEventsRequest, ListPage, ListPageRequest, SessionEvent, SessionPersistDriver, SessionRecord } from "sandbox-agent";
import { sandboxSessionEvents, sandboxSessions } from "./db/schema.js";

const DEFAULT_MAX_SESSIONS = 1024;
const DEFAULT_MAX_EVENTS_PER_SESSION = 500;
const DEFAULT_LIST_LIMIT = 100;

function normalizeCap(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.floor(value as number);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function resolveEventListOffset(params: { cursor?: string; total: number; limit: number }): number {
  if (params.cursor != null) {
    return parseCursor(params.cursor);
  }
  return Math.max(0, params.total - params.limit);
}

function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    return item;
  });
}

function safeParseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface SandboxInstancePersistDriverOptions {
  maxSessions?: number;
  maxEventsPerSession?: number;
}

export class SandboxInstancePersistDriver implements SessionPersistDriver {
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;

  constructor(
    private readonly db: any,
    options: SandboxInstancePersistDriverOptions = {},
  ) {
    this.maxSessions = normalizeCap(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.maxEventsPerSession = normalizeCap(options.maxEventsPerSession, DEFAULT_MAX_EVENTS_PER_SESSION);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = await this.db
      .select({
        id: sandboxSessions.id,
        agent: sandboxSessions.agent,
        agentSessionId: sandboxSessions.agentSessionId,
        lastConnectionId: sandboxSessions.lastConnectionId,
        createdAt: sandboxSessions.createdAt,
        destroyedAt: sandboxSessions.destroyedAt,
        sessionInitJson: sandboxSessions.sessionInitJson,
      })
      .from(sandboxSessions)
      .where(eq(sandboxSessions.id, id))
      .get();

    if (!row) return null;

    return {
      id: row.id,
      agent: row.agent,
      agentSessionId: row.agentSessionId,
      lastConnectionId: row.lastConnectionId,
      createdAt: row.createdAt,
      destroyedAt: row.destroyedAt ?? undefined,
      sessionInit: safeParseJson(row.sessionInitJson, undefined),
    };
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    const offset = parseCursor(request.cursor);
    const limit = normalizeCap(request.limit, DEFAULT_LIST_LIMIT);

    const rows = await this.db
      .select({
        id: sandboxSessions.id,
        agent: sandboxSessions.agent,
        agentSessionId: sandboxSessions.agentSessionId,
        lastConnectionId: sandboxSessions.lastConnectionId,
        createdAt: sandboxSessions.createdAt,
        destroyedAt: sandboxSessions.destroyedAt,
        sessionInitJson: sandboxSessions.sessionInitJson,
      })
      .from(sandboxSessions)
      .orderBy(asc(sandboxSessions.createdAt), asc(sandboxSessions.id))
      .limit(limit)
      .offset(offset)
      .all();

    const items = rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      agentSessionId: row.agentSessionId,
      lastConnectionId: row.lastConnectionId,
      createdAt: row.createdAt,
      destroyedAt: row.destroyedAt ?? undefined,
      sessionInit: safeParseJson(row.sessionInitJson, undefined),
    }));

    const totalRow = await this.db.select({ c: count() }).from(sandboxSessions).get();
    const total = Number(totalRow?.c ?? 0);

    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : undefined,
    };
  }

  async updateSession(session: SessionRecord): Promise<void> {
    const now = Date.now();
    await this.db
      .insert(sandboxSessions)
      .values({
        id: session.id,
        agent: session.agent,
        agentSessionId: session.agentSessionId,
        lastConnectionId: session.lastConnectionId,
        createdAt: session.createdAt ?? now,
        destroyedAt: session.destroyedAt ?? null,
        sessionInitJson: session.sessionInit ? safeStringify(session.sessionInit) : null,
      })
      .onConflictDoUpdate({
        target: sandboxSessions.id,
        set: {
          agent: session.agent,
          agentSessionId: session.agentSessionId,
          lastConnectionId: session.lastConnectionId,
          createdAt: session.createdAt ?? now,
          destroyedAt: session.destroyedAt ?? null,
          sessionInitJson: session.sessionInit ? safeStringify(session.sessionInit) : null,
        },
      })
      .run();

    // Evict oldest sessions beyond cap.
    const totalRow = await this.db.select({ c: count() }).from(sandboxSessions).get();
    const total = Number(totalRow?.c ?? 0);
    const overflow = total - this.maxSessions;
    if (overflow <= 0) return;

    const toRemove = await this.db
      .select({ id: sandboxSessions.id })
      .from(sandboxSessions)
      .orderBy(asc(sandboxSessions.createdAt), asc(sandboxSessions.id))
      .limit(overflow)
      .all();

    for (const row of toRemove) {
      await this.db.delete(sandboxSessionEvents).where(eq(sandboxSessionEvents.sessionId, row.id)).run();
      await this.db.delete(sandboxSessions).where(eq(sandboxSessions.id, row.id)).run();
    }
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    const limit = normalizeCap(request.limit, DEFAULT_LIST_LIMIT);
    const totalRow = await this.db.select({ c: count() }).from(sandboxSessionEvents).where(eq(sandboxSessionEvents.sessionId, request.sessionId)).get();
    const total = Number(totalRow?.c ?? 0);
    const offset = resolveEventListOffset({
      cursor: request.cursor,
      total,
      limit,
    });

    const rows = await this.db
      .select({
        id: sandboxSessionEvents.id,
        sessionId: sandboxSessionEvents.sessionId,
        eventIndex: sandboxSessionEvents.eventIndex,
        createdAt: sandboxSessionEvents.createdAt,
        connectionId: sandboxSessionEvents.connectionId,
        sender: sandboxSessionEvents.sender,
        payloadJson: sandboxSessionEvents.payloadJson,
      })
      .from(sandboxSessionEvents)
      .where(eq(sandboxSessionEvents.sessionId, request.sessionId))
      .orderBy(asc(sandboxSessionEvents.eventIndex), asc(sandboxSessionEvents.id))
      .limit(limit)
      .offset(offset)
      .all();

    const items: SessionEvent[] = rows.map((row) => ({
      id: row.id,
      eventIndex: row.eventIndex,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      connectionId: row.connectionId,
      sender: row.sender as any,
      payload: safeParseJson(row.payloadJson, null),
    }));

    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < total ? String(nextOffset) : undefined,
    };
  }

  async insertEvent(event: SessionEvent): Promise<void> {
    await this.db
      .insert(sandboxSessionEvents)
      .values({
        id: event.id,
        sessionId: event.sessionId,
        eventIndex: event.eventIndex,
        createdAt: event.createdAt,
        connectionId: event.connectionId,
        sender: event.sender,
        payloadJson: safeStringify(event.payload),
      })
      .onConflictDoUpdate({
        target: sandboxSessionEvents.id,
        set: {
          sessionId: event.sessionId,
          eventIndex: event.eventIndex,
          createdAt: event.createdAt,
          connectionId: event.connectionId,
          sender: event.sender,
          payloadJson: safeStringify(event.payload),
        },
      })
      .run();

    // Trim oldest events beyond cap.
    const totalRow = await this.db.select({ c: count() }).from(sandboxSessionEvents).where(eq(sandboxSessionEvents.sessionId, event.sessionId)).get();
    const total = Number(totalRow?.c ?? 0);
    const overflow = total - this.maxEventsPerSession;
    if (overflow <= 0) return;

    const toRemove = await this.db
      .select({ id: sandboxSessionEvents.id })
      .from(sandboxSessionEvents)
      .where(eq(sandboxSessionEvents.sessionId, event.sessionId))
      .orderBy(asc(sandboxSessionEvents.eventIndex), asc(sandboxSessionEvents.id))
      .limit(overflow)
      .all();

    for (const row of toRemove) {
      await this.db
        .delete(sandboxSessionEvents)
        .where(and(eq(sandboxSessionEvents.sessionId, event.sessionId), eq(sandboxSessionEvents.id, row.id)))
        .run();
    }
  }
}
