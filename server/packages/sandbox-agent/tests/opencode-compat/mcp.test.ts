/**
 * Tests for OpenCode MCP integration.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

interface McpServerHandle {
  url: string;
  close: () => Promise<void>;
}

async function startMcpServer(): Promise<McpServerHandle> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.statusCode = 404;
      res.end();
      return;
    }

    const body = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk.toString();
      });
      req.on("end", () => resolve(data));
    });

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }

    const authHeader = req.headers.authorization;
    if (authHeader !== "Bearer test-token") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload?.id ?? null,
          error: { code: 401, message: "unauthorized" },
        })
      );
      return;
    }

    let result: any;
    switch (payload?.method) {
      case "initialize":
        result = {
          serverInfo: { name: "test-mcp", version: "0.1.0" },
          capabilities: { tools: {} },
        };
        break;
      case "tools/list":
        result = {
          tools: [
            {
              name: "echo",
              description: "Echo text",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
        };
        break;
      default:
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload?.id ?? null,
            error: { code: -32601, message: "method not found" },
          })
        );
        return;
    }

    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result,
      })
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return {
    url,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe("OpenCode MCP Integration", () => {
  let handle: SandboxAgentHandle;
  let mcpServer: McpServerHandle;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    mcpServer = await startMcpServer();
    handle = await spawnSandboxAgent({ opencodeCompat: true });
  });

  afterEach(async () => {
    await handle?.dispose();
    await mcpServer?.close();
  });

  it("should authenticate and list MCP tools", async () => {
    const headers = {
      Authorization: `Bearer ${handle.token}`,
      "Content-Type": "application/json",
    };

    const registerResponse = await fetch(`${handle.baseUrl}/opencode/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "test",
        config: {
          type: "remote",
          url: mcpServer.url,
          oauth: { clientId: "client" },
          enabled: true,
        },
      }),
    });
    expect(registerResponse.ok).toBe(true);
    const registerData = await registerResponse.json();
    expect(registerData?.test?.status).toBe("needs_auth");

    const authResponse = await fetch(`${handle.baseUrl}/opencode/mcp/test/auth`, {
      method: "POST",
      headers,
    });
    expect(authResponse.ok).toBe(true);
    const authData = await authResponse.json();
    expect(typeof authData?.authorizationUrl).toBe("string");

    const callbackResponse = await fetch(`${handle.baseUrl}/opencode/mcp/test/auth/callback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "test-token" }),
    });
    expect(callbackResponse.ok).toBe(true);
    const callbackData = await callbackResponse.json();
    expect(callbackData?.status).toBe("disabled");

    const connectResponse = await fetch(`${handle.baseUrl}/opencode/mcp/test/connect`, {
      method: "POST",
      headers,
    });
    expect(connectResponse.ok).toBe(true);
    expect(await connectResponse.json()).toBe(true);

    const idsResponse = await fetch(`${handle.baseUrl}/opencode/experimental/tool/ids`, {
      headers,
    });
    expect(idsResponse.ok).toBe(true);
    const ids = await idsResponse.json();
    expect(ids).toContain("mcp:test:echo");

    const listResponse = await fetch(
      `${handle.baseUrl}/opencode/experimental/tool?provider=sandbox-agent&model=mock`,
      { headers }
    );
    expect(listResponse.ok).toBe(true);
    const tools = await listResponse.json();
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mcp:test:echo",
          description: "Echo text",
        }),
      ])
    );
  });
});
