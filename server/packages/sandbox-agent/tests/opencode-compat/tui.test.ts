/**
 * Tests for OpenCode-compatible TUI control endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

type TuiClient = {
  appendPrompt: (args: unknown) => Promise<{ data?: unknown }>;
  executeCommand: (args: unknown) => Promise<{ data?: unknown }>;
  showToast: (args: unknown) => Promise<{ data?: unknown }>;
  control: {
    next: (args?: unknown) => Promise<{ data?: unknown }>;
    response: (args: unknown) => Promise<{ data?: unknown }>;
  };
};

describe("OpenCode-compatible TUI Control API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let tui: TuiClient;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    tui = client.tui as unknown as TuiClient;
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  it("queues TUI control requests in order", async () => {
    await tui.appendPrompt({ body: { text: "First" } });
    await tui.executeCommand({ body: { command: "prompt.clear" } });
    await tui.showToast({ body: { message: "Hello", variant: "info" } });

    const first = (await tui.control.next({})).data as {
      path: string;
      body: { text?: string };
      requestID?: string;
    };
    const second = (await tui.control.next({})).data as {
      path: string;
      body: { command?: string };
      requestID?: string;
    };
    const third = (await tui.control.next({})).data as {
      path: string;
      body: { message?: string };
      requestID?: string;
    };

    expect(first.path).toBe("/tui/append-prompt");
    expect(first.body.text).toBe("First");
    expect(first.requestID).toBeDefined();

    expect(second.path).toBe("/tui/execute-command");
    expect(second.body.command).toBe("prompt.clear");
    expect(second.requestID).toBeDefined();

    expect(third.path).toBe("/tui/show-toast");
    expect(third.body.message).toBe("Hello");
    expect(third.requestID).toBeDefined();

    const empty = (await tui.control.next({})).data as {
      path: string;
      body: Record<string, unknown>;
    };
    expect(empty.path).toBe("");
    expect(empty.body).toEqual({});
  });

  it("handles control responses with request IDs", async () => {
    await tui.appendPrompt({ body: { text: "Ack me" } });
    const next = (await tui.control.next({})).data as { requestID?: string };
    expect(next.requestID).toBeDefined();

    const accepted = await tui.control.response({
      body: { requestID: next.requestID, body: { ok: true } },
    });
    expect(accepted.data).toBe(true);

    const duplicate = await tui.control.response({
      body: { requestID: next.requestID, body: { ok: false } },
    });
    expect(duplicate.data).toBe(false);

    const missing = await tui.control.response({
      body: { requestID: "tui_missing" },
    });
    expect(missing.data).toBe(false);
  });
});
