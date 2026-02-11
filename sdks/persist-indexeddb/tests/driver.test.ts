import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { IndexedDbSessionPersistDriver } from "../src/index.ts";

function uniqueDbName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

describe("IndexedDbSessionPersistDriver", () => {
  it("stores and pages sessions and events", async () => {
    const dbName = uniqueDbName("indexeddb-driver");
    const driver = new IndexedDbSessionPersistDriver({ databaseName: dbName });

    await driver.updateSession({
      id: "s-1",
      agent: "mock",
      agentSessionId: "a-1",
      lastConnectionId: "c-1",
      createdAt: 100,
    });

    await driver.updateSession({
      id: "s-2",
      agent: "mock",
      agentSessionId: "a-2",
      lastConnectionId: "c-2",
      createdAt: 200,
      destroyedAt: 300,
    });

    await driver.insertEvent({
      id: "evt-1",
      eventIndex: 1,
      sessionId: "s-1",
      createdAt: 1,
      connectionId: "c-1",
      sender: "client",
      payload: { jsonrpc: "2.0", method: "session/prompt", params: { sessionId: "a-1" } },
    });

    await driver.insertEvent({
      id: "evt-2",
      eventIndex: 2,
      sessionId: "s-1",
      createdAt: 2,
      connectionId: "c-1",
      sender: "agent",
      payload: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "a-1" } },
    });

    const loaded = await driver.getSession("s-2");
    expect(loaded?.destroyedAt).toBe(300);

    const page1 = await driver.listSessions({ limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.id).toBe("s-1");
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await driver.listSessions({ cursor: page1.nextCursor, limit: 1 });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).toBe("s-2");
    expect(page2.nextCursor).toBeUndefined();

    const eventsPage = await driver.listEvents({ sessionId: "s-1", limit: 10 });
    expect(eventsPage.items).toHaveLength(2);
    expect(eventsPage.items[0]?.id).toBe("evt-1");
    expect(eventsPage.items[0]?.eventIndex).toBe(1);
    expect(eventsPage.items[1]?.id).toBe("evt-2");
    expect(eventsPage.items[1]?.eventIndex).toBe(2);

    await driver.close();
  });

  it("persists across driver instances for same database", async () => {
    const dbName = uniqueDbName("indexeddb-reopen");

    {
      const driver = new IndexedDbSessionPersistDriver({ databaseName: dbName });
      await driver.updateSession({
        id: "s-1",
        agent: "mock",
        agentSessionId: "a-1",
        lastConnectionId: "c-1",
        createdAt: 1,
      });
      await driver.close();
    }

    {
      const driver = new IndexedDbSessionPersistDriver({ databaseName: dbName });
      const session = await driver.getSession("s-1");
      expect(session?.id).toBe("s-1");
      await driver.close();
    }
  });
});
