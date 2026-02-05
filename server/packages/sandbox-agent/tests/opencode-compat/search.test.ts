/**
 * Tests for OpenCode-compatible search endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("OpenCode-compatible Search API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let fixtureDir: string;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "opencode-search-"));
    await mkdir(join(fixtureDir, "src"), { recursive: true });

    await writeFile(
      join(fixtureDir, "src", "lib.rs"),
      [
        "pub struct Greeter;",
        "",
        "impl Greeter {",
        "    pub fn greet(name: &str) -> String {",
        "        format!(\"Hello, {}\", name)",
        "    }",
        "}",
        "",
        "pub fn add(a: i32, b: i32) -> i32 {",
        "    a + b // needle",
        "}",
        "",
      ].join("\n")
    );

    await writeFile(join(fixtureDir, "README.md"), "Search fixture");

    handle = await spawnSandboxAgent({
      opencodeCompat: true,
      env: {
        OPENCODE_COMPAT_DIRECTORY: fixtureDir,
        OPENCODE_COMPAT_WORKTREE: fixtureDir,
      },
    });

    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("finds text matches", async () => {
    const response = await client.find.text({
      query: { pattern: "needle" },
    });

    expect(response.error).toBeUndefined();
    expect(response.data?.length).toBeGreaterThan(0);

    const match = response.data?.find((entry) => entry.path.text.endsWith("src/lib.rs"));
    expect(match).toBeDefined();
    expect(match?.lines.text).toContain("needle");
  });

  it("finds files", async () => {
    const response = await client.find.files({
      query: { query: "lib.rs" },
    });

    expect(response.error).toBeUndefined();
    expect(response.data).toContain("src/lib.rs");
  });

  it("finds symbols", async () => {
    const response = await client.find.symbols({
      query: { query: "greet" },
    });

    expect(response.error).toBeUndefined();
    const symbols = response.data ?? [];
    expect(symbols.some((symbol) => symbol.name === "greet")).toBe(true);
  });
});
