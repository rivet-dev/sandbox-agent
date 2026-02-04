/**
 * Tests for OpenCode-compatible provider auth endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Provider Auth API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  it("should set/remove credentials and update connected providers", async () => {
    const initial = await client.provider.list();
    const providers = initial.data?.all ?? [];
    expect(providers.some((provider) => provider.id === "anthropic")).toBe(true);

    const setResponse = await client.auth.set({
      path: { providerID: "anthropic" },
      body: { type: "api", key: "sk-test" },
    });
    expect(setResponse.data).toBe(true);

    const afterSet = await client.provider.list();
    expect(afterSet.data?.connected?.includes("anthropic")).toBe(true);

    const removeResponse = await client.auth.remove({
      path: { providerID: "anthropic" },
    });
    expect(removeResponse.data).toBe(true);

    const afterRemove = await client.provider.list();
    expect(afterRemove.data?.connected?.includes("anthropic")).toBe(false);
  });
});
