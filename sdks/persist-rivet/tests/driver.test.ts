import { describe, it, expect } from "vitest";
import { RivetSessionPersistDriver } from "../src/index.ts";
import type { RivetPersistData } from "../src/index.ts";

function makeCtx() {
  return { state: {} as Record<string, unknown> };
}

describe("RivetSessionPersistDriver", () => {
  it("auto-initializes state on construction", () => {
    const ctx = makeCtx();
    new RivetSessionPersistDriver(ctx);
    const data = ctx.state._sandboxAgentPersist as RivetPersistData;
    expect(data).toBeDefined();
    expect(data.sessions).toEqual({});
    expect(data.events).toEqual({});
  });

  it("preserves existing state on construction (actor wake)", async () => {
    const ctx = makeCtx();
    const driver1 = new RivetSessionPersistDriver(ctx);

    await driver1.updateSession({
      id: "s-1",
      agent: "mock",
      agentSessionId: "a-1",
      lastConnectionId: "c-1",
      createdAt: 100,
    });

    // Simulate actor wake: new driver instance, same state object
    const driver2 = new RivetSessionPersistDriver(ctx);
    const session = await driver2.getSession("s-1");
    expect(session?.id).toBe("s-1");
    expect(session?.createdAt).toBe(100);
  });

  it("stores and retrieves sessions", async () => {
    const driver = new RivetSessionPersistDriver(makeCtx());

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

    const loaded = await driver.getSession("s-2");
    expect(loaded?.destroyedAt).toBe(300);

    const missing = await driver.getSession("s-nonexistent");
    expect(missing).toBeNull();
  });

  it("pages sessions sorted by createdAt", async () => {
    const driver = new RivetSessionPersistDriver(makeCtx());

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
    });

    const page1 = await driver.listSessions({ limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.id).toBe("s-1");
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await driver.listSessions({ cursor: page1.nextCursor, limit: 1 });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).toBe("s-2");
    expect(page2.nextCursor).toBeUndefined();
  });

  it("stores and pages events", async () => {
    const driver = new RivetSessionPersistDriver(makeCtx());

    await driver.updateSession({
      id: "s-1",
      agent: "mock",
      agentSessionId: "a-1",
      lastConnectionId: "c-1",
      createdAt: 1,
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

    const eventsPage = await driver.listEvents({ sessionId: "s-1", limit: 10 });
    expect(eventsPage.items).toHaveLength(2);
    expect(eventsPage.items[0]?.id).toBe("evt-1");
    expect(eventsPage.items[0]?.eventIndex).toBe(1);
    expect(eventsPage.items[1]?.id).toBe("evt-2");
    expect(eventsPage.items[1]?.eventIndex).toBe(2);
  });

  it("evicts oldest sessions when maxSessions exceeded", async () => {
    const driver = new RivetSessionPersistDriver(makeCtx(), { maxSessions: 2 });

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
    });

    // Adding a third session should evict the oldest (s-1)
    await driver.updateSession({
      id: "s-3",
      agent: "mock",
      agentSessionId: "a-3",
      lastConnectionId: "c-3",
      createdAt: 300,
    });

    expect(await driver.getSession("s-1")).toBeNull();
    expect(await driver.getSession("s-2")).not.toBeNull();
    expect(await driver.getSession("s-3")).not.toBeNull();
  });

  it("trims oldest events when maxEventsPerSession exceeded", async () => {
    const driver = new RivetSessionPersistDriver(makeCtx(), { maxEventsPerSession: 2 });

    await driver.updateSession({
      id: "s-1",
      agent: "mock",
      agentSessionId: "a-1",
      lastConnectionId: "c-1",
      createdAt: 1,
    });

    for (let i = 1; i <= 3; i++) {
      await driver.insertEvent({
        id: `evt-${i}`,
        eventIndex: i,
        sessionId: "s-1",
        createdAt: i,
        connectionId: "c-1",
        sender: "client",
        payload: { jsonrpc: "2.0", method: "session/prompt", params: { sessionId: "a-1" } },
      });
    }

    const page = await driver.listEvents({ sessionId: "s-1" });
    expect(page.items).toHaveLength(2);
    // Oldest event (evt-1) should be trimmed
    expect(page.items[0]?.id).toBe("evt-2");
    expect(page.items[1]?.id).toBe("evt-3");
  });

  it("clones data to prevent external mutation", async () => {
    const driver = new RivetSessionPersistDriver(makeCtx());

    await driver.updateSession({
      id: "s-1",
      agent: "mock",
      agentSessionId: "a-1",
      lastConnectionId: "c-1",
      createdAt: 1,
    });

    const s1 = await driver.getSession("s-1");
    const s2 = await driver.getSession("s-1");
    expect(s1).toEqual(s2);
    expect(s1).not.toBe(s2); // Different object references
  });

  it("supports custom stateKey", async () => {
    const ctx = makeCtx();
    const driver = new RivetSessionPersistDriver(ctx, { stateKey: "myPersist" });

    await driver.updateSession({
      id: "s-1",
      agent: "mock",
      agentSessionId: "a-1",
      lastConnectionId: "c-1",
      createdAt: 1,
    });

    expect((ctx.state.myPersist as RivetPersistData).sessions["s-1"]).toBeDefined();
    expect(ctx.state._sandboxAgentPersist).toBeUndefined();
  });

  it("returns empty results for unknown session events", async () => {
    const driver = new RivetSessionPersistDriver(makeCtx());
    const page = await driver.listEvents({ sessionId: "nonexistent" });
    expect(page.items).toHaveLength(0);
    expect(page.nextCursor).toBeUndefined();
  });
});
