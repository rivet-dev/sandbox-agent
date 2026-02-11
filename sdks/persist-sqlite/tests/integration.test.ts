import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SandboxAgent } from "sandbox-agent";
import { spawnSandboxAgent, type SandboxAgentSpawnHandle } from "../../typescript/src/spawn.ts";
import { prepareMockAgentDataHome } from "../../typescript/tests/helpers/mock-agent.ts";
import { SQLiteSessionPersistDriver } from "../src/index.ts";

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

const BINARY_PATH = findBinary();
if (!BINARY_PATH) {
  throw new Error(
    "sandbox-agent binary not found. Build it (cargo build -p sandbox-agent) or set SANDBOX_AGENT_BIN.",
  );
}
if (!process.env.SANDBOX_AGENT_BIN) {
  process.env.SANDBOX_AGENT_BIN = BINARY_PATH;
}

describe("SQLite persistence driver", () => {
  let handle: SandboxAgentSpawnHandle;
  let baseUrl: string;
  let token: string;
  let dataHome: string;

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "sqlite-integration-"));
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

  it("persists session/event history across SDK instances and supports replay restore", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "sqlite-persist-"));
    const dbPath = join(tempDir, "session-store.db");

    const persist1 = new SQLiteSessionPersistDriver({ filename: dbPath });
    const sdk1 = await SandboxAgent.connect({
      baseUrl,
      token,
      persist: persist1,
      replayMaxEvents: 40,
      replayMaxChars: 16000,
    });

    const created = await sdk1.createSession({ agent: "mock" });
    await created.prompt([{ type: "text", text: "sqlite-first" }]);
    const firstConnectionId = created.lastConnectionId;

    await sdk1.dispose();
    persist1.close();

    const persist2 = new SQLiteSessionPersistDriver({ filename: dbPath });
    const sdk2 = await SandboxAgent.connect({
      baseUrl,
      token,
      persist: persist2,
      replayMaxEvents: 40,
      replayMaxChars: 16000,
    });

    const restored = await sdk2.resumeSession(created.id);
    expect(restored.lastConnectionId).not.toBe(firstConnectionId);

    await restored.prompt([{ type: "text", text: "sqlite-second" }]);

    const sessions = await sdk2.listSessions({ limit: 20 });
    expect(sessions.items.some((entry) => entry.id === created.id)).toBe(true);

    const events = await sdk2.getEvents({ sessionId: created.id, limit: 1000 });
    expect(events.items.length).toBeGreaterThan(0);
    expect(events.items.every((event) => typeof event.id === "string")).toBe(true);
    expect(events.items.every((event) => Number.isInteger(event.eventIndex))).toBe(true);

    for (let i = 1; i < events.items.length; i += 1) {
      expect(events.items[i]!.eventIndex).toBeGreaterThanOrEqual(events.items[i - 1]!.eventIndex);
    }

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
    persist2.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
});
