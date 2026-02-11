import "fake-indexeddb/auto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SandboxAgent } from "sandbox-agent";
import { spawnSandboxAgent, type SandboxAgentSpawnHandle } from "../../typescript/src/spawn.ts";
import { prepareMockAgentDataHome } from "../../typescript/tests/helpers/mock-agent.ts";
import { IndexedDbSessionPersistDriver } from "../src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function uniqueDbName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

describe("IndexedDB persistence end-to-end", () => {
  let handle: SandboxAgentSpawnHandle;
  let baseUrl: string;
  let token: string;
  let dataHome: string;

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "indexeddb-integration-"));
    prepareMockAgentDataHome(dataHome);

    handle = await spawnSandboxAgent({
      enabled: true,
      log: "silent",
      timeoutMs: 30000,
      env: {
        XDG_DATA_HOME: dataHome,
      },
    });
    baseUrl = handle.baseUrl;
    token = handle.token;
  });

  afterAll(async () => {
    await handle.dispose();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("restores sessions/events across sdk instances", async () => {
    const dbName = uniqueDbName("sandbox-agent-browser-e2e");

    const persist1 = new IndexedDbSessionPersistDriver({ databaseName: dbName });
    const sdk1 = await SandboxAgent.connect({
      baseUrl,
      token,
      persist: persist1,
      replayMaxEvents: 40,
      replayMaxChars: 16000,
    });

    const created = await sdk1.createSession({ agent: "mock" });
    await created.prompt([{ type: "text", text: "indexeddb-first" }]);
    const firstConnectionId = created.lastConnectionId;

    await sdk1.dispose();
    await persist1.close();

    const persist2 = new IndexedDbSessionPersistDriver({ databaseName: dbName });
    const sdk2 = await SandboxAgent.connect({
      baseUrl,
      token,
      persist: persist2,
      replayMaxEvents: 40,
      replayMaxChars: 16000,
    });

    const restored = await sdk2.resumeSession(created.id);
    expect(restored.lastConnectionId).not.toBe(firstConnectionId);

    await restored.prompt([{ type: "text", text: "indexeddb-second" }]);

    const sessions = await sdk2.listSessions({ limit: 20 });
    expect(sessions.items.some((entry) => entry.id === created.id)).toBe(true);

    const events = await sdk2.getEvents({ sessionId: created.id, limit: 1000 });
    expect(events.items.length).toBeGreaterThan(0);

    const replayInjected = events.items.find((event) => {
      if (event.sender !== "client") {
        return false;
      }
      const payload = event.payload as Record<string, unknown>;
      const method = payload.method;
      const params = payload.params as Record<string, unknown> | undefined;
      const prompt = Array.isArray(params?.prompt) ? params?.prompt : [];
      const firstBlock = prompt[0] as Record<string, unknown> | undefined;
      return (
        method === "session/prompt" &&
        typeof firstBlock?.text === "string" &&
        firstBlock.text.includes("Previous session history is replayed below")
      );
    });

    expect(replayInjected).toBeTruthy();

    await sdk2.dispose();
    await persist2.close();
  });
});
