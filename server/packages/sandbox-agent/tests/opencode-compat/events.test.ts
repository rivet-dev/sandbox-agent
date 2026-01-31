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
