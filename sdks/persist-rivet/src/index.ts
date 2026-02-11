import type {
  ListEventsRequest,
  ListPage,
  ListPageRequest,
  SessionEvent,
  SessionPersistDriver,
  SessionRecord,
} from "sandbox-agent";

/** Structural type compatible with rivetkit's ActorContext without importing it. */
export interface ActorContextLike {
  state: Record<string, unknown>;
}

export interface RivetPersistData {
  sessions: Record<string, SessionRecord>;
  events: Record<string, SessionEvent[]>;
}

export type RivetPersistState = {
  _sandboxAgentPersist: RivetPersistData;
};

export interface RivetSessionPersistDriverOptions {
  /** Maximum number of sessions to retain. Oldest are evicted first. Default: 1024. */
  maxSessions?: number;
  /** Maximum events per session. Oldest are trimmed first. Default: 500. */
  maxEventsPerSession?: number;
  /** Key on `c.state` where persist data is stored. Default: `"_sandboxAgentPersist"`. */
  stateKey?: string;
}

const DEFAULT_MAX_SESSIONS = 1024;
const DEFAULT_MAX_EVENTS_PER_SESSION = 500;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_STATE_KEY = "_sandboxAgentPersist";

export class RivetSessionPersistDriver implements SessionPersistDriver {
  private readonly maxSessions: number;
  private readonly maxEventsPerSession: number;
  private readonly stateKey: string;
  private readonly ctx: ActorContextLike;

  constructor(ctx: ActorContextLike, options: RivetSessionPersistDriverOptions = {}) {
    this.ctx = ctx;
    this.maxSessions = normalizeCap(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.maxEventsPerSession = normalizeCap(
      options.maxEventsPerSession,
      DEFAULT_MAX_EVENTS_PER_SESSION,
    );
    this.stateKey = options.stateKey ?? DEFAULT_STATE_KEY;

    // Auto-initialize if absent; preserve existing data on actor wake.
    if (!this.ctx.state[this.stateKey]) {
      this.ctx.state[this.stateKey] = { sessions: {}, events: {} } satisfies RivetPersistData;
    }
  }

  private get data(): RivetPersistData {
    return this.ctx.state[this.stateKey] as RivetPersistData;
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const session = this.data.sessions[id];
    return session ? cloneSessionRecord(session) : null;
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<SessionRecord>> {
    const sorted = Object.values(this.data.sessions).sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
      }
      return a.id.localeCompare(b.id);
    });
    const page = paginate(sorted, request);
    return {
      items: page.items.map(cloneSessionRecord),
      nextCursor: page.nextCursor,
    };
  }

  async updateSession(session: SessionRecord): Promise<void> {
    this.data.sessions[session.id] = { ...session };

    if (!this.data.events[session.id]) {
      this.data.events[session.id] = [];
    }

    const ids = Object.keys(this.data.sessions);
    if (ids.length <= this.maxSessions) {
      return;
    }

    const overflow = ids.length - this.maxSessions;
    const removable = Object.values(this.data.sessions)
      .sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt - b.createdAt;
        }
        return a.id.localeCompare(b.id);
      })
      .slice(0, overflow)
      .map((s) => s.id);

    for (const sessionId of removable) {
      delete this.data.sessions[sessionId];
      delete this.data.events[sessionId];
    }
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    const all = [...(this.data.events[request.sessionId] ?? [])].sort((a, b) => {
      if (a.eventIndex !== b.eventIndex) {
        return a.eventIndex - b.eventIndex;
      }
      return a.id.localeCompare(b.id);
    });
    const page = paginate(all, request);
    return {
      items: page.items.map(cloneSessionEvent),
      nextCursor: page.nextCursor,
    };
  }

  async insertEvent(event: SessionEvent): Promise<void> {
    const events = this.data.events[event.sessionId] ?? [];
    events.push(cloneSessionEvent(event));

    if (events.length > this.maxEventsPerSession) {
      events.splice(0, events.length - this.maxEventsPerSession);
    }

    this.data.events[event.sessionId] = events;
  }
}

function cloneSessionRecord(session: SessionRecord): SessionRecord {
  return {
    ...session,
    sessionInit: session.sessionInit
      ? (JSON.parse(JSON.stringify(session.sessionInit)) as SessionRecord["sessionInit"])
      : undefined,
  };
}

function cloneSessionEvent(event: SessionEvent): SessionEvent {
  return {
    ...event,
    payload: JSON.parse(JSON.stringify(event.payload)) as SessionEvent["payload"],
  };
}

function normalizeCap(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.floor(value as number);
}

function paginate<T>(items: T[], request: ListPageRequest): ListPage<T> {
  const offset = parseCursor(request.cursor);
  const limit = normalizeCap(request.limit, DEFAULT_LIST_LIMIT);
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}
