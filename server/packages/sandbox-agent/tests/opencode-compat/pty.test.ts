/**
 * Tests for OpenCode-compatible PTY endpoints.
 */

import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import WebSocket from "ws";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

const waitForOpen = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", (err) => reject(err));
  });

const waitForMessage = (socket: WebSocket, predicate: (text: string) => boolean, timeoutMs = 5000) =>
  new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for PTY output"));
    }, timeoutMs);

    const onMessage = (data: WebSocket.RawData) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (predicate(text)) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(text);
      }
    };

    socket.on("message", onMessage);
  });

describe("OpenCode-compatible PTY API", () => {
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

  it("should create/list/get/update/delete PTYs", async () => {
    const created = await client.pty.create({
      body: { command: "cat", title: "Echo" },
    });
    const ptyId = created.data?.id;
    expect(ptyId).toBeDefined();

    const list = await client.pty.list();
    expect(list.data?.some((pty) => pty.id === ptyId)).toBe(true);

    const fetched = await client.pty.get({ path: { ptyID: ptyId! } });
    expect(fetched.data?.id).toBe(ptyId);

    await client.pty.update({
      path: { ptyID: ptyId! },
      body: { title: "Updated" },
    });

    const updated = await client.pty.get({ path: { ptyID: ptyId! } });
    expect(updated.data?.title).toBe("Updated");

    await client.pty.remove({ path: { ptyID: ptyId! } });

    const deleted = await client.pty.get({ path: { ptyID: ptyId! } });
    expect(deleted.error).toBeDefined();
  });

  it("should stream PTY output and accept input", async () => {
    const created = await client.pty.create({
      body: { command: "cat" },
    });
    const ptyId = created.data?.id;
    expect(ptyId).toBeDefined();

    const wsUrl = new URL(`/opencode/pty/${ptyId}/connect`, handle.baseUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(wsUrl.toString(), {
      headers: { Authorization: `Bearer ${handle.token}` },
    });

    await waitForOpen(socket);
    socket.send("hello\n");

    const output = await waitForMessage(socket, (text) => text.includes("hello"));
    expect(output).toContain("hello");

    socket.close();
  });
});
