import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("OpenCode-compatible filesystem API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let tempDir: string;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "opencode-fs-"));
    await writeFile(join(tempDir, "hello.txt"), "hello world\n");
    await mkdir(join(tempDir, "nested"), { recursive: true });
    await writeFile(join(tempDir, "nested", "child.txt"), "child content\n");

    handle = await spawnSandboxAgent({
      opencodeCompat: true,
      env: {
        OPENCODE_COMPAT_DIRECTORY: tempDir,
        OPENCODE_COMPAT_WORKTREE: tempDir,
      },
    });

    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists files within the workspace", async () => {
    const response = await client.file.list({
      query: { path: "." },
    });

    expect(response.data).toBeDefined();
    expect(Array.isArray(response.data)).toBe(true);
    const paths = (response.data ?? []).map((entry) => entry.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("nested");
  });

  it("reads file content", async () => {
    const response = await client.file.read({
      query: { path: "hello.txt" },
    });

    expect(response.data).toBeDefined();
    expect(response.data?.type).toBe("text");
    expect(response.data?.content).toContain("hello world");
  });

  it("rejects paths outside the workspace", async () => {
    const response = await client.file.read({
      query: { path: "../outside.txt" },
    });

    expect(response.error).toBeDefined();
  });
});
