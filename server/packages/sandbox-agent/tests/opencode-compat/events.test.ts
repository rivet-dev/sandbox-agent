/**
 * Tests for OpenCode-compatible event streaming endpoints.
 *
 * These tests verify that sandbox-agent exposes OpenCode-compatible SSE event
 * endpoints that can be used with the official OpenCode SDK.
 *
 * Expected endpoints:
 * - GET /event - Subscribe to all events (SSE)
 * - GET /global/event - Subscribe to global events (SSE)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

type SseEvent = {
  id?: string;
  data: any;
};

function parseSseMessage(raw: string): SseEvent | null {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const dataLines: string[] = [];
  let id: string | undefined;

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const dataText = dataLines.join("\n");
  try {
    return { id, data: JSON.parse(dataText) };
  } catch {
    return null;
  }
}

async function collectSseEvents(
  url: string,
  options: { headers: Record<string, string>; limit: number; timeoutMs: number }
): Promise<SseEvent[]> {
  const { headers, limit, timeoutMs } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { headers, signal: controller.signal });
  expect(response.ok).toBe(true);
  if (!response.body) {
    clearTimeout(timeout);
    throw new Error("SSE response missing body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  const events: SseEvent[] = [];

  try {
    for await (const chunk of response.body as any) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseMessage(raw);
        if (parsed) {
          events.push(parsed);
          if (events.length >= limit) {
            controller.abort();
            clearTimeout(timeout);
            return events;
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  }

  clearTimeout(timeout);
  return events;
}

describe("OpenCode-compatible Event Streaming", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  describe("event.subscribe", () => {
    it("should connect to SSE endpoint", async () => {
      // The event.subscribe returns an SSE stream
      const response = await client.event.subscribe();

      expect(response).toBeDefined();
      expect((response as any).stream).toBeDefined();
    });

    it("should receive session.created event when session is created", async () => {
      const events: any[] = [];

      // Start listening for events
      const eventStream = await client.event.subscribe();

      // Set up event collection with timeout
      const collectEvents = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              events.push(event);
              if (event.type === "session.created") {
                clearTimeout(timeout);
                resolve();
                break;
              }
            }
          } catch {
            // Stream ended or errored
          }
        })();
      });

      // Create a session
      await client.session.create({ body: { title: "Event Test" } });

      await collectEvents;

      // Should have received at least one session.created event
      const sessionCreatedEvent = events.find((e) => e.type === "session.created");
      expect(sessionCreatedEvent).toBeDefined();
    });

    it("should receive message.part.updated events during prompt", async () => {
      const events: any[] = [];

      // Create a session first
      const session = await client.session.create();
      const sessionId = session.data?.id!;

      // Start listening for events
      const eventStream = await client.event.subscribe();

      const collectEvents = new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10000);
        (async () => {
          try {
            for await (const event of (eventStream as any).stream) {
              events.push(event);
              // Look for message part updates or completion
              if (
                event.type === "message.part.updated" ||
                event.type === "session.idle"
              ) {
                if (events.length >= 3) {
                  clearTimeout(timeout);
                  resolve();
                  break;
                }
              }
            }
          } catch {
            // Stream ended
          }
        })();
      });

      // Send a prompt
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "sandbox-agent", modelID: "mock" },
          parts: [{ type: "text", text: "Say hello" }],
        },
      });

      await collectEvents;

      // Should have received some events
      expect(events.length).toBeGreaterThan(0);
    });

    it("should replay ordered events by offset", async () => {
      const headers = { Authorization: `Bearer ${handle.token}` };
      const eventUrl = `${handle.baseUrl}/opencode/event?offset=0`;

      const initialEventsPromise = collectSseEvents(eventUrl, {
        headers,
        limit: 10,
        timeoutMs: 10000,
      });

      const session = await client.session.create();
      const sessionId = session.data?.id!;
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: "sandbox-agent", modelID: "mock" },
          parts: [{ type: "text", text: "Say hello" }],
        },
      });

      const initialEvents = await initialEventsPromise;
      const filteredInitial = initialEvents.filter(
        (event) => event.data?.type && event.data.type !== "server.heartbeat"
      );
      expect(filteredInitial.length).toBeGreaterThan(0);

      const ids = filteredInitial
        .map((event) => Number(event.id))
        .filter((value) => Number.isFinite(value));
      expect(ids.length).toBeGreaterThan(0);
      for (let i = 1; i < ids.length; i += 1) {
        expect(ids[i]).toBeGreaterThan(ids[i - 1]);
      }

      const types = new Set(filteredInitial.map((event) => event.data.type));
      expect(types.has("session.status")).toBe(true);
      expect(types.has("message.updated")).toBe(true);
      expect(types.has("message.part.updated")).toBe(true);

      const partEvent = filteredInitial.find(
        (event) => event.data.type === "message.part.updated"
      );
      expect(partEvent?.data?.properties?.part).toBeDefined();

      const lastId = Math.max(...ids);
      const followupSession = await client.session.create();
      const followupId = followupSession.data?.id!;
      await client.session.prompt({
        path: { id: followupId },
        body: {
          model: { providerID: "sandbox-agent", modelID: "mock" },
          parts: [{ type: "text", text: "Say hi again" }],
        },
      });

      const replayEvents = await collectSseEvents(
        `${handle.baseUrl}/opencode/event?offset=${lastId}`,
        {
          headers,
          limit: 8,
          timeoutMs: 10000,
        }
      );
      const filteredReplay = replayEvents.filter(
        (event) => event.data?.type && event.data.type !== "server.heartbeat"
      );
      expect(filteredReplay.length).toBeGreaterThan(0);

      const replayIds = filteredReplay
        .map((event) => Number(event.id))
        .filter((value) => Number.isFinite(value));
      expect(replayIds.length).toBeGreaterThan(0);
      expect(Math.min(...replayIds)).toBeGreaterThan(lastId);
    });
  });

  describe("global.event", () => {
    it("should connect to global SSE endpoint", async () => {
      const response = await client.global.event();

      expect(response).toBeDefined();
    });
  });

  describe("session.status", () => {
    it("should return session status", async () => {
      const session = await client.session.create();
      const sessionId = session.data?.id!;

      const response = await client.session.status();

      expect(response.data).toBeDefined();
    });
  });
});
