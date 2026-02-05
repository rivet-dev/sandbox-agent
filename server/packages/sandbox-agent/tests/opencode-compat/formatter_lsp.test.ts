/**
 * Tests for OpenCode-compatible formatter + LSP endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Formatter + LSP status", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let workspaceDir: string;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "opencode-compat-"));
    await writeFile(join(workspaceDir, "main.rs"), "fn main() {}\n");
    await writeFile(join(workspaceDir, "app.ts"), "const value = 1;\n");

    handle = await spawnSandboxAgent({
      opencodeCompat: true,
      env: {
        OPENCODE_COMPAT_DIRECTORY: workspaceDir,
        OPENCODE_COMPAT_WORKTREE: workspaceDir,
      },
    });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("should report formatter status for workspace languages", async () => {
    const response = await client.formatter.status({ query: { directory: workspaceDir } });
    const entries = response.data ?? [];

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    const hasRust = entries.some((entry: any) => entry.extensions?.includes(".rs"));
    const hasTs = entries.some((entry: any) => entry.extensions?.includes(".ts"));
    expect(hasRust).toBe(true);
    expect(hasTs).toBe(true);

    for (const entry of entries) {
      expect(typeof entry.enabled).toBe("boolean");
    }
  });

  it("should report lsp status for workspace languages", async () => {
    const response = await client.lsp.status({ query: { directory: workspaceDir } });
    const entries = response.data ?? [];

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    const hasRust = entries.some((entry: any) => entry.id === "rust-analyzer");
    const hasTs = entries.some((entry: any) => entry.id === "typescript-language-server");
    expect(hasRust).toBe(true);
    expect(hasTs).toBe(true);

    for (const entry of entries) {
      expect(entry.root).toBe(workspaceDir);
      expect(["connected", "error"]).toContain(entry.status);
    }
  });
});
