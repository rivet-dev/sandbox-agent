import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlreadyConnectedError,
  NotConnectedError,
  SandboxAgent,
  SandboxAgentClient,
  type AgentEvent,
} from "../src/index.ts";
import { spawnSandboxAgent, isNodeRuntime, type SandboxAgentSpawnHandle } from "../src/spawn.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_UNPARSED_METHOD = "_sandboxagent/agent/unparsed";

function findBinary(): string | null {
  if (process.env.SANDBOX_AGENT_BIN) {
    return process.env.SANDBOX_AGENT_BIN;
  }

  const cargoPaths = [
    resolve(__dirname, "../../../target/debug/sandbox-agent"),
    resolve(__dirname, "../../../target/release/sandbox-agent"),
  ];

  for (const p of cargoPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

const BINARY_PATH = findBinary();
if (!BINARY_PATH) {
  throw new Error(
    "sandbox-agent binary not found. Build it (cargo build -p sandbox-agent) or set SANDBOX_AGENT_BIN.",
  );
}
if (!process.env.SANDBOX_AGENT_BIN) {
  process.env.SANDBOX_AGENT_BIN = BINARY_PATH;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  fn: () => T | undefined | null,
  timeoutMs = 5000,
  stepMs = 25,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value !== undefined && value !== null) {
      return value;
    }
    await sleep(stepMs);
  }
  throw new Error("timed out waiting for condition");
}

describe("Integration: TypeScript SDK against real server/runtime", () => {
  let handle: SandboxAgentSpawnHandle;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    handle = await spawnSandboxAgent({
      enabled: true,
      log: "silent",
      timeoutMs: 30000,
    });
    baseUrl = handle.baseUrl;
    token = handle.token;
  });

  afterAll(async () => {
    await handle.dispose();
  });

  it("detects Node.js runtime", () => {
    expect(isNodeRuntime()).toBe(true);
  });

  it("keeps health on HTTP and requires ACP connection for ACP-backed helpers", async () => {
    const client = await SandboxAgent.connect({
      baseUrl,
      token,
      agent: "mock",
      autoConnect: false,
    });

    const health = await client.getHealth();
    expect(health.status).toBe("ok");

    await expect(client.listAgents()).rejects.toBeInstanceOf(NotConnectedError);

    await client.connect();
    const agents = await client.listAgents();
    expect(Array.isArray(agents.agents)).toBe(true);
    expect(agents.agents.length).toBeGreaterThan(0);

    await client.disconnect();
  });

  it("auto-connects on constructor and runs initialize/new/prompt flow", async () => {
    const events: AgentEvent[] = [];

    const client = new SandboxAgentClient({
      baseUrl,
      token,
      agent: "mock",
      onEvent: (event) => {
        events.push(event);
      },
    });

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      metadata: {
        agent: "mock",
      },
    });
    expect(session.sessionId).toBeTruthy();

    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hello integration" }],
    });
    expect(prompt.stopReason).toBe("end_turn");

    await waitFor(() => {
      const text = events
        .filter((event): event is Extract<AgentEvent, { type: "sessionUpdate" }> => {
          return event.type === "sessionUpdate";
        })
        .map((event) => event.notification)
        .filter((entry) => entry.update.sessionUpdate === "agent_message_chunk")
        .map((entry) => entry.update.content)
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("");
      return text.includes("mock: hello integration") ? text : undefined;
    });

    await client.disconnect();
  });

  it("enforces manual connect and disconnect lifecycle when autoConnect is disabled", async () => {
    const client = new SandboxAgentClient({
      baseUrl,
      token,
      agent: "mock",
      autoConnect: false,
    });

    await expect(
      client.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        metadata: {
          agent: "mock",
        },
      }),
    ).rejects.toBeInstanceOf(NotConnectedError);

    await client.connect();

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      metadata: {
        agent: "mock",
      },
    });
    expect(session.sessionId).toBeTruthy();

    await client.disconnect();

    await expect(
      client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "after disconnect" }],
      }),
    ).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("rejects duplicate connect calls for a single client instance", async () => {
    const client = new SandboxAgentClient({
      baseUrl,
      token,
      agent: "mock",
      autoConnect: false,
    });

    await client.connect();
    await expect(client.connect()).rejects.toBeInstanceOf(AlreadyConnectedError);
    await client.disconnect();
  });

  it("injects metadata on newSession and extracts metadata from session/list", async () => {
    const client = new SandboxAgentClient({
      baseUrl,
      token,
      agent: "mock",
      autoConnect: false,
    });

    await client.connect();

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      metadata: {
        agent: "mock",
        variant: "high",
      },
    });

    await client.setMetadata(session.sessionId, {
      title: "sdk title",
      permissionMode: "ask",
      model: "mock",
    });

    const listed = await client.unstableListSessions({});
    const current = listed.sessions.find((entry) => entry.sessionId === session.sessionId) as
      | (Record<string, unknown> & { metadata?: Record<string, unknown> })
      | undefined;

    expect(current).toBeTruthy();
    expect(current?.title).toBe("sdk title");

    const metadata =
      (current?.metadata as Record<string, unknown> | undefined) ??
      ((current?._meta as Record<string, unknown> | undefined)?.["sandboxagent.dev"] as
        | Record<string, unknown>
        | undefined);

    expect(metadata?.variant).toBe("high");
    expect(metadata?.permissionMode).toBe("ask");
    expect(metadata?.model).toBe("mock");

    await client.disconnect();
  });

  it("converts _sandboxagent/session/ended into typed agent events", async () => {
    const events: AgentEvent[] = [];
    const client = new SandboxAgentClient({
      baseUrl,
      token,
      agent: "mock",
      autoConnect: false,
      onEvent: (event) => {
        events.push(event);
      },
    });

    await client.connect();

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      metadata: {
        agent: "mock",
      },
    });

    await client.terminateSession(session.sessionId);

    const ended = await waitFor(() => {
      return events.find((event) => event.type === "sessionEnded");
    });

    expect(ended.type).toBe("sessionEnded");
    if (ended.type === "sessionEnded") {
      const endedSessionId =
        ended.notification.params.sessionId ?? ended.notification.params.session_id;
      expect(endedSessionId).toBe(session.sessionId);
    }

    await client.disconnect();
  });

  it("converts _sandboxagent/agent/unparsed notifications through the event adapter", async () => {
    const events: AgentEvent[] = [];
    const client = new SandboxAgentClient({
      baseUrl,
      token,
      autoConnect: false,
      onEvent: (event) => {
        events.push(event);
      },
    });

    (client as any).handleEnvelope(
      {
        jsonrpc: "2.0",
        method: AGENT_UNPARSED_METHOD,
        params: {
          raw: "unexpected payload",
        },
      },
      "inbound",
    );

    const unparsed = events.find((event) => event.type === "agentUnparsed");
    expect(unparsed?.type).toBe("agentUnparsed");
  });

  it("rejects invalid token on protected /v2 endpoints", async () => {
    const client = new SandboxAgentClient({
      baseUrl,
      token: "invalid-token",
      autoConnect: false,
    });

    await expect(client.getHealth()).rejects.toThrow();
  });
});
