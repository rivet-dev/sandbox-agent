/**
 * Tests for OpenCode-compatible tool calls and file actions.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Tool + File Actions", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let sessionId: string;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });

    const session = await client.session.create();
    sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  it("should emit tool and file parts plus file.edited events", async () => {
    const eventStream = await client.event.subscribe();
    const tracker = {
      tool: false,
      file: false,
      edited: false,
      pending: false,
      completed: false,
    };

    const waiter = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for tool events")), 15_000);
      (async () => {
        try {
          for await (const event of (eventStream as any).stream) {
            if (event.type === "message.part.updated") {
              const part = event.properties?.part;
              if (part?.type === "tool") {
                tracker.tool = true;
                if (part?.state?.status === "pending") {
                  tracker.pending = true;
                }
                if (part?.state?.status === "completed") {
                  tracker.completed = true;
                }
              }
              if (part?.type === "file") {
                tracker.file = true;
              }
            }
            if (event.type === "file.edited") {
              tracker.edited = true;
            }
            if (
              tracker.tool &&
              tracker.file &&
              tracker.edited &&
              tracker.pending &&
              tracker.completed
            ) {
              clearTimeout(timeout);
              resolve();
              break;
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      })();
    });

    await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: "sandbox-agent", modelID: "mock" },
        parts: [{ type: "text", text: "tool" }],
      },
    });

    await waiter;
    expect(tracker.tool).toBe(true);
    expect(tracker.file).toBe(true);
    expect(tracker.edited).toBe(true);
  });

  it("should emit tool lifecycle states", async () => {
    const eventStream = await client.event.subscribe();
    const statuses = new Set<string>();

    const waiter = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for tool lifecycle")), 15_000);
      (async () => {
        try {
          for await (const event of (eventStream as any).stream) {
            if (event.type === "message.part.updated") {
              const part = event.properties?.part;
              if (part?.type === "tool") {
                const status = part?.state?.status;
                if (status) {
                  statuses.add(status);
                }
              }
            }
            if (statuses.has("pending") && statuses.has("running") && (statuses.has("completed") || statuses.has("error"))) {
              clearTimeout(timeout);
              resolve();
              break;
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      })();
    });

    await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: { providerID: "sandbox-agent", modelID: "mock" },
        parts: [{ type: "text", text: "tool" }],
      },
    });

    await waiter;
    expect(statuses.has("pending")).toBe(true);
    expect(statuses.has("running")).toBe(true);
    expect(statuses.has("completed") || statuses.has("error")).toBe(true);
  });
});
