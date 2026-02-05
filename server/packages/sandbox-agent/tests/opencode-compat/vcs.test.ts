/**
 * Tests for OpenCode-compatible VCS endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

async function createFixtureRepo(): Promise<{ dir: string; filePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-vcs-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  const filePath = join(dir, "README.md");
  await writeFile(filePath, "hello\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return { dir, filePath };
}

describe("OpenCode-compatible VCS API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let repoDir: string;
  let filePath: string;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    const repo = await createFixtureRepo();
    repoDir = repo.dir;
    filePath = repo.filePath;

    handle = await spawnSandboxAgent({
      opencodeCompat: true,
      env: {
        OPENCODE_COMPAT_DIRECTORY: repoDir,
        OPENCODE_COMPAT_WORKTREE: repoDir,
        OPENCODE_COMPAT_BRANCH: "main",
      },
    });

    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("returns branch and diff entries", async () => {
    const vcs = await client.vcs.get({ query: { directory: repoDir } });
    expect(vcs.data?.branch).toBe("main");

    const session = await client.session.create();
    const sessionId = session.data?.id!;

    await writeFile(filePath, "hello\nworld\n", "utf8");

    const diff = await client.session.diff({
      path: { sessionID: sessionId },
      query: { directory: repoDir },
    });

    expect(diff.data?.length).toBe(1);
    const entry = diff.data?.[0]!;
    expect(entry.file).toBe("README.md");
    expect(entry.before).toContain("hello");
    expect(entry.after).toContain("world");
    expect(entry.additions).toBeGreaterThan(0);
  });

  it("reverts and unreverts working tree changes", async () => {
    const session = await client.session.create();
    const sessionId = session.data?.id!;

    await writeFile(filePath, "hello\nchanged\n", "utf8");

    await client.session.revert({
      path: { sessionID: sessionId },
      query: { directory: repoDir },
      body: { messageID: "msg_test" },
    });

    const reverted = await readFile(filePath, "utf8");
    expect(reverted).toBe("hello\n");

    await client.session.unrevert({
      path: { sessionID: sessionId },
      query: { directory: repoDir },
    });

    const restored = await readFile(filePath, "utf8");
    expect(restored).toBe("hello\nchanged\n");
  });
});
