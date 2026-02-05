/**
 * Tests for OpenCode-compatible search endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(__dirname, "fixtures/search-fixture");

describe("OpenCode-compatible Search API", () => {
  let handle: SandboxAgentHandle;

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
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  it("should return text matches", async () => {
    const url = new URL(`${handle.baseUrl}/opencode/find`);
    url.searchParams.set("pattern", "SearchWidget");
    url.searchParams.set("limit", "10");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);

    const hit = data.find((entry: any) => entry?.path?.text?.endsWith("src/app.ts"));
    expect(hit).toBeDefined();
    expect(hit?.lines?.text).toContain("SearchWidget");
  });

  it("should respect case-insensitive search", async () => {
    const url = new URL(`${handle.baseUrl}/opencode/find`);
    url.searchParams.set("pattern", "searchwidget");
    url.searchParams.set("caseSensitive", "false");
    url.searchParams.set("limit", "10");

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(response.ok).toBe(true);

    const data = await response.json();
    const hit = data.find((entry: any) => entry?.path?.text?.endsWith("src/app.ts"));
    expect(hit).toBeDefined();
  });

  it("should return file and symbol hits", async () => {
    const filesUrl = new URL(`${handle.baseUrl}/opencode/find/file`);
    filesUrl.searchParams.set("query", "src/*.ts");
    filesUrl.searchParams.set("limit", "10");

    const filesResponse = await fetch(filesUrl, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(filesResponse.ok).toBe(true);

    const files = await filesResponse.json();
    expect(Array.isArray(files)).toBe(true);
    expect(files).toContain("src/app.ts");

    const symbolsUrl = new URL(`${handle.baseUrl}/opencode/find/symbol`);
    symbolsUrl.searchParams.set("query", "findMatches");
    symbolsUrl.searchParams.set("limit", "10");

    const symbolsResponse = await fetch(symbolsUrl, {
      headers: { Authorization: `Bearer ${handle.token}` },
    });
    expect(symbolsResponse.ok).toBe(true);

    const symbols = await symbolsResponse.json();
    expect(Array.isArray(symbols)).toBe(true);
    const match = symbols.find((entry: any) => entry?.name === "findMatches");
    expect(match).toBeDefined();
    expect(match?.location?.uri).toContain("src/app.ts");
  });
});
