import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  InMemorySessionPersistDriver,
  SandboxAgent,
  type SessionEvent,
} from "../src/index.ts";
import { spawnSandboxAgent, isNodeRuntime, type SandboxAgentSpawnHandle } from "../src/spawn.ts";
import { prepareMockAgentDataHome } from "./helpers/mock-agent.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isZeroBlock(block: Uint8Array): boolean {
  for (const b of block) {
    if (b !== 0) {
      return false;
    }
  }
  return true;
}

function readTarString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  let end = 0;
  while (end < slice.length && slice[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(slice.subarray(0, end));
}

function readTarOctal(block: Uint8Array, offset: number, length: number): number {
  const raw = readTarString(block, offset, length).trim();
  if (!raw) {
    return 0;
  }
  return Number.parseInt(raw, 8);
}

function normalizeTarPath(p: string): string {
  let out = p.replaceAll("\\", "/");
  while (out.startsWith("./")) {
    out = out.slice(2);
  }
  while (out.startsWith("/")) {
    out = out.slice(1);
  }
  return out;
}

function untarFiles(tarBytes: Uint8Array): Map<string, Uint8Array> {
  // Minimal ustar tar reader for tests. Supports regular files and directories.
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      const next = tarBytes.subarray(offset + 512, offset + 1024);
      if (next.length === 512 && isZeroBlock(next)) {
        break;
      }
      offset += 512;
      continue;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = normalizeTarPath(prefix ? `${prefix}/${name}` : name);
    const size = readTarOctal(header, 124, 12);
    const typeflag = readTarString(header, 156, 1);

    offset += 512;
    const content = tarBytes.subarray(offset, offset + size);

    // Regular file type is "0" (or NUL). Directories are "5".
    if ((typeflag === "" || typeflag === "0") && fullName) {
      files.set(fullName, content);
    }

    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

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
  timeoutMs = 6000,
  stepMs = 30,
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

describe("Integration: TypeScript SDK flat session API", () => {
  let handle: SandboxAgentSpawnHandle;
  let baseUrl: string;
  let token: string;
  let dataHome: string;

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "sdk-integration-"));
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

  it("detects Node.js runtime", () => {
    expect(isNodeRuntime()).toBe(true);
  });

  it("creates a session, sends prompt, and persists events", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });

    const observed: SessionEvent[] = [];
    const off = session.onEvent((event) => {
      observed.push(event);
    });

    const prompt = await session.prompt([{ type: "text", text: "hello flat sdk" }]);
    expect(prompt.stopReason).toBe("end_turn");

    await waitFor(() => {
      const inbound = observed.find((event) => event.sender === "agent");
      return inbound;
    });

    const listed = await sdk.listSessions({ limit: 20 });
    expect(listed.items.some((entry) => entry.id === session.id)).toBe(true);

    const fetched = await sdk.getSession(session.id);
    expect(fetched?.agent).toBe("mock");

    const events = await sdk.getEvents({ sessionId: session.id, limit: 100 });
    expect(events.items.length).toBeGreaterThan(0);
    expect(events.items.some((event) => event.sender === "client")).toBe(true);
    expect(events.items.some((event) => event.sender === "agent")).toBe(true);
    expect(events.items.every((event) => typeof event.id === "string")).toBe(true);
    expect(events.items.every((event) => Number.isInteger(event.eventIndex))).toBe(true);

    for (let i = 1; i < events.items.length; i += 1) {
      expect(events.items[i]!.eventIndex).toBeGreaterThanOrEqual(events.items[i - 1]!.eventIndex);
    }

    off();
    await sdk.dispose();
  });

  it("restores a session on stale connection by recreating and replaying history on first prompt", async () => {
    const persist = new InMemorySessionPersistDriver({
      maxEventsPerSession: 200,
    });

    const first = await SandboxAgent.connect({
      baseUrl,
      token,
      persist,
      replayMaxEvents: 50,
      replayMaxChars: 20_000,
    });

    const created = await first.createSession({ agent: "mock" });
    await created.prompt([{ type: "text", text: "first run" }]);
    const oldConnectionId = created.lastConnectionId;

    await first.dispose();

    const second = await SandboxAgent.connect({
      baseUrl,
      token,
      persist,
      replayMaxEvents: 50,
      replayMaxChars: 20_000,
    });

    const restored = await second.resumeSession(created.id);
    expect(restored.lastConnectionId).not.toBe(oldConnectionId);

    await restored.prompt([{ type: "text", text: "second run" }]);

    const events = await second.getEvents({ sessionId: restored.id, limit: 500 });

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

    await second.dispose();
  });

  it("enforces in-memory event cap to avoid leaks", async () => {
    const persist = new InMemorySessionPersistDriver({
      maxEventsPerSession: 8,
    });

    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
      persist,
    });

    const session = await sdk.createSession({ agent: "mock" });

    for (let i = 0; i < 20; i += 1) {
      await session.prompt([{ type: "text", text: `event-cap-${i}` }]);
    }

    const events = await sdk.getEvents({ sessionId: session.id, limit: 200 });
    expect(events.items.length).toBeLessThanOrEqual(8);

    await sdk.dispose();
  });

  it("supports MCP and skills config HTTP helpers", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const directory = mkdtempSync(join(tmpdir(), "sdk-config-"));

    const mcpConfig = {
      type: "local" as const,
      command: "node",
      args: ["server.js"],
      env: { LOG_LEVEL: "debug" },
    };

    await sdk.setMcpConfig(
      {
        directory,
        mcpName: "local-test",
      },
      mcpConfig,
    );

    const loadedMcp = await sdk.getMcpConfig({
      directory,
      mcpName: "local-test",
    });
    expect(loadedMcp.type).toBe("local");

    await sdk.deleteMcpConfig({
      directory,
      mcpName: "local-test",
    });

    const skillsConfig = {
      sources: [
        {
          type: "github",
          source: "rivet-dev/skills",
          skills: ["sandbox-agent"],
        },
      ],
    };

    await sdk.setSkillsConfig(
      {
        directory,
        skillName: "default",
      },
      skillsConfig,
    );

    const loadedSkills = await sdk.getSkillsConfig({
      directory,
      skillName: "default",
    });
    expect(Array.isArray(loadedSkills.sources)).toBe(true);

    await sdk.deleteSkillsConfig({
      directory,
      skillName: "default",
    });

    await sdk.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it("supports filesystem download batch (tar)", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const root = mkdtempSync(join(tmpdir(), "sdk-fs-download-batch-"));
    const dir = join(root, "docs");
    const nested = join(dir, "nested");
    await sdk.mkdirFs({ path: nested });
    await sdk.writeFsFile({ path: join(dir, "a.txt") }, new TextEncoder().encode("aaa"));
    await sdk.writeFsFile({ path: join(nested, "b.txt") }, new TextEncoder().encode("bbb"));

    const tarBytes = await sdk.downloadFsBatch({ path: dir });
    expect(tarBytes.length).toBeGreaterThan(0);

    const files = untarFiles(tarBytes);
    const a = files.get("a.txt");
    const b = files.get("nested/b.txt");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(new TextDecoder().decode(a!)).toBe("aaa");
    expect(new TextDecoder().decode(b!)).toBe("bbb");

    await sdk.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it("supports filesystem upload batch from sourcePath (requires tar)", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const sourceRoot = mkdtempSync(join(tmpdir(), "sdk-upload-source-"));
    const sourceDir = join(sourceRoot, "project");
    mkdirSync(join(sourceDir, "nested"), { recursive: true });
    writeFileSync(join(sourceDir, "a.txt"), "aaa");
    writeFileSync(join(sourceDir, "nested", "b.txt"), "bbb");

    const destRoot = mkdtempSync(join(tmpdir(), "sdk-upload-dest-"));
    const destDir = join(destRoot, "uploaded");

    await sdk.uploadFsBatch({ sourcePath: sourceDir }, { path: destDir });

    const a = await sdk.readFsFile({ path: join(destDir, "a.txt") });
    const b = await sdk.readFsFile({ path: join(destDir, "nested", "b.txt") });
    expect(new TextDecoder().decode(a)).toBe("aaa");
    expect(new TextDecoder().decode(b)).toBe("bbb");

    await sdk.dispose();
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(destRoot, { recursive: true, force: true });
  });

  it("supports filesystem download batch to outPath and extractTo (requires tar for extract)", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const serverRoot = mkdtempSync(join(tmpdir(), "sdk-download-server-"));
    const serverDir = join(serverRoot, "docs");
    await sdk.mkdirFs({ path: join(serverDir, "nested") });
    await sdk.writeFsFile({ path: join(serverDir, "a.txt") }, new TextEncoder().encode("aaa"));
    await sdk.writeFsFile(
      { path: join(serverDir, "nested", "b.txt") },
      new TextEncoder().encode("bbb"),
    );

    const localRoot = mkdtempSync(join(tmpdir(), "sdk-download-local-"));
    const outTar = join(localRoot, "docs.tar");
    const extractTo = join(localRoot, "extracted");

    const bytes = await sdk.downloadFsBatch(
      { path: serverDir },
      { outPath: outTar, extractTo },
    );
    expect(bytes.length).toBeGreaterThan(0);

    const extractedA = readFileSync(join(extractTo, "a.txt"), "utf8");
    const extractedB = readFileSync(join(extractTo, "nested", "b.txt"), "utf8");
    expect(extractedA).toBe("aaa");
    expect(extractedB).toBe("bbb");

    await sdk.dispose();
    rmSync(serverRoot, { recursive: true, force: true });
    rmSync(localRoot, { recursive: true, force: true });
  });
});
