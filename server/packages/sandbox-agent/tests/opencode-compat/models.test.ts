/**
 * Tests for OpenCode-compatible provider/model listing.
 */

import { describe, it, expect, beforeAll, afterEach, beforeEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Model API", () => {
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

  it("should list models grouped by agent with real model IDs", async () => {
    const response = await client.provider.list();
    const provider = response.data?.all?.find((entry) => entry.id === "sandbox-agent");
    expect(provider).toBeDefined();

    const models = provider?.models ?? {};
    const modelIds = Object.keys(models);
    expect(modelIds.length).toBeGreaterThan(0);

    expect(models["mock"]).toBeDefined();
    expect(models["mock"].id).toBe("mock");
    expect(models["mock"].family).toBe("Mock");

    expect(models["smart"]).toBeDefined();
    expect(models["smart"].id).toBe("smart");
    expect(models["smart"].family).toBe("Amp");

    expect(models["amp"]).toBeUndefined();
    expect(response.data?.default?.["sandbox-agent"]).toBe("mock");
  });
});
