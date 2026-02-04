/**
 * Tests for OpenCode-compatible command/shell execution endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Command Execution", () => {
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

  it("session.command should return output and emit events", async () => {
    const events: any[] = [];
    const eventStream = await client.event.subscribe();

    const waitForOutput = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10000);
      (async () => {
        try {
          for await (const event of (eventStream as any).stream) {
            events.push(event);
            if (event.type === "message.part.updated") {
              const text = event?.properties?.part?.text ?? "";
              if (text.includes("hello-command")) {
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

    const response = await client.session.command({
      path: { id: sessionId },
      body: {
        agent: "build",
        model: "mock",
        command: "echo",
        arguments: "hello-command",
      },
    });

    expect(response.error).toBeUndefined();
    const parts = (response.data as any)?.parts ?? [];
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0]?.text ?? "").toContain("hello-command");

    await waitForOutput;
    expect(events.length).toBeGreaterThan(0);
  });

  it("session.shell should emit output events", async () => {
    const events: any[] = [];
    const eventStream = await client.event.subscribe();

    const waitForOutput = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10000);
      (async () => {
        try {
          for await (const event of (eventStream as any).stream) {
            events.push(event);
            if (event.type === "message.part.updated") {
              const text = event?.properties?.part?.text ?? "";
              if (text.includes("hello-shell")) {
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

    const response = await client.session.shell({
      path: { id: sessionId },
      body: {
        agent: "build",
        model: { providerID: "sandbox-agent", modelID: "mock" },
        command: "echo hello-shell",
      },
    });

    expect(response.error).toBeUndefined();

    await waitForOutput;
    expect(events.length).toBeGreaterThan(0);
  });
});
