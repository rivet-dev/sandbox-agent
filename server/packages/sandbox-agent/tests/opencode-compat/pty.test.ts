/**
 * Tests for OpenCode-compatible PTY endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible PTY API", () => {
  let handle: SandboxAgentHandle;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  async function createPty(body: Record<string, unknown>) {
    const response = await fetch(`${handle.baseUrl}/opencode/pty`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    return { response, data };
  }

  async function deletePty(id: string) {
    await fetch(`${handle.baseUrl}/opencode/pty/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  }

  async function connectPty(id: string): Promise<WebSocket> {
    const wsUrl = `${handle.baseUrl.replace("http", "ws")}/opencode/pty/${id}/connect`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${handle.token}` },
      });
      ws.once("open", () => resolve(ws));
      ws.once("error", (err) => reject(err));
    });
  }

  function waitForOutput(
    ws: WebSocket,
    matcher: (text: string) => boolean,
    timeoutMs = 5000
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for output")), timeoutMs);
      const onMessage = (data: WebSocket.RawData) => {
        const text = data.toString();
        if (matcher(text)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(text);
        }
      };
      ws.on("message", onMessage);
    });
  }

  it("should spawn a pty session", async () => {
    const { response, data } = await createPty({ command: "sh" });

    expect(response.ok).toBe(true);
    expect(data.id).toMatch(/^pty_/);
    expect(data.status).toBe("running");
    expect(typeof data.pid).toBe("number");

    await deletePty(data.id);
  });

  it("should capture output from pty", async () => {
    const { data } = await createPty({ command: "sh" });
    const ws = await connectPty(data.id);

    const outputPromise = waitForOutput(ws, (text) => text.includes("hello-pty"));
    ws.send("echo hello-pty\n");

    const output = await outputPromise;
    expect(output).toContain("hello-pty");

    ws.close();
    await deletePty(data.id);
  });

  it("should echo input back through pty", async () => {
    const { data } = await createPty({ command: "cat" });
    const ws = await connectPty(data.id);

    const outputPromise = waitForOutput(ws, (text) => text.includes("ping-pty"));
    ws.send("ping-pty\n");

    const output = await outputPromise;
    expect(output).toContain("ping-pty");

    ws.close();
    await deletePty(data.id);
  });
});
