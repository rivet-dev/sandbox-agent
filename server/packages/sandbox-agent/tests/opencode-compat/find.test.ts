import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(__dirname, "fixtures/search-repo");

describe("OpenCode-compatible Find API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({
      opencodeCompat: true,
      env: {
        OPENCODE_COMPAT_DIRECTORY: fixtureRoot,
        OPENCODE_COMPAT_WORKTREE: fixtureRoot,
      },
    });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  it("should find matching text", async () => {
    const response = await client.find.text({
      query: { directory: fixtureRoot, pattern: "Needle" },
    });
    const results = (response as any).data ?? [];
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((match: any) => match.path?.text?.includes("README.md"))).toBe(true);
  });

  it("should find matching files", async () => {
    const response = await client.find.files({
      query: { directory: fixtureRoot, query: "example.ts" },
    });
    const results = (response as any).data ?? [];
    expect(results).toContain("src/example.ts");
  });

  it("should find matching symbols", async () => {
    const response = await client.find.symbols({
      query: { directory: fixtureRoot, query: "greet" },
    });
    const results = (response as any).data ?? [];
    expect(results.some((symbol: any) => symbol.name === "greet")).toBe(true);
  });
});
