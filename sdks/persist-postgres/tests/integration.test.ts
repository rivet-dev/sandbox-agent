import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { SandboxAgent } from "sandbox-agent";
import { spawnSandboxAgent, type SandboxAgentSpawnHandle } from "../../typescript/src/spawn.ts";
import { prepareMockAgentDataHome } from "../../typescript/tests/helpers/mock-agent.ts";
import { PostgresSessionPersistDriver } from "../src/index.ts";

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

interface PostgresContainer {
  containerId: string;
  connectionString: string;
}

describe("Postgres persistence driver", () => {
  let handle: SandboxAgentSpawnHandle;
  let baseUrl: string;
  let token: string;
  let dataHome: string;
  let postgres: PostgresContainer | null = null;

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "postgres-integration-"));
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

  beforeEach(async () => {
    postgres = await startPostgresContainer();
  });

  afterEach(() => {
    if (postgres) {
      stopPostgresContainer(postgres.containerId);
      postgres = null;
    }
  });

  afterAll(async () => {
    await handle.dispose();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("persists session/event history across SDK instances and supports replay restore", async () => {
    const connectionString = requirePostgres(postgres).connectionString;

    const persist1 = new PostgresSessionPersistDriver({
      connectionString,
    });

    const sdk1 = await SandboxAgent.connect({
      baseUrl,
      token,
      persist: persist1,
      replayMaxEvents: 40,
      replayMaxChars: 16000,
    });

    const created = await sdk1.createSession({ agent: "mock" });
    await created.prompt([{ type: "text", text: "postgres-first" }]);
    const firstConnectionId = created.lastConnectionId;

    await sdk1.dispose();
    await persist1.close();

    const persist2 = new PostgresSessionPersistDriver({
      connectionString,
    });
    const sdk2 = await SandboxAgent.connect({
      baseUrl,
      token,
      persist: persist2,
      replayMaxEvents: 40,
      replayMaxChars: 16000,
    });

    const restored = await sdk2.resumeSession(created.id);
    expect(restored.lastConnectionId).not.toBe(firstConnectionId);

    await restored.prompt([{ type: "text", text: "postgres-second" }]);

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
    await persist2.close();
  });
});

async function startPostgresContainer(): Promise<PostgresContainer> {
  const name = `sandbox-agent-postgres-${randomUUID()}`;
  const containerId = runDockerCommand([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "-e",
    "POSTGRES_USER=postgres",
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "-e",
    "POSTGRES_DB=sandboxagent",
    "-p",
    "127.0.0.1::5432",
    "postgres:16-alpine",
  ]);

  const portOutput = runDockerCommand(["port", containerId, "5432/tcp"]);
  const port = parsePort(portOutput);
  const connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/sandboxagent`;
  await waitForPostgres(connectionString);

  return {
    containerId,
    connectionString,
  };
}

function stopPostgresContainer(containerId: string): void {
  try {
    runDockerCommand(["rm", "-f", containerId]);
  } catch {
    // Container may already be gone when test teardown runs.
  }
}

function runDockerCommand(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parsePort(output: string): string {
  const firstLine = output.split("\n")[0]?.trim() ?? "";
  const match = firstLine.match(/:(\d+)$/);
  if (!match) {
    throw new Error(`Failed to parse docker port output: '${output}'`);
  }
  return match[1];
}

async function waitForPostgres(connectionString: string): Promise<void> {
  const timeoutMs = 30000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      try {
        await client.end();
      } catch {
        // Ignore cleanup failures while retrying.
      }
      await delay(250);
    }
  }

  throw new Error(`Postgres container did not become ready: ${String(lastError)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function requirePostgres(container: PostgresContainer | null): PostgresContainer {
  if (!container) {
    throw new Error("Postgres container was not initialized for this test.");
  }
  return container;
}
