// @ts-nocheck
import { describe, expect, it } from "vitest";
import { setupTest } from "rivetkit/test";
import { workspaceKey } from "../src/actors/keys.js";
import { registry } from "../src/actors/index.js";
import { createTestDriver } from "./helpers/test-driver.js";
import { createTestRuntimeContext } from "./helpers/test-context.js";

const runActorIntegration = process.env.HF_ENABLE_ACTOR_INTEGRATION_TESTS === "1";

describe("workspace star sandbox agent repo", () => {
  it.skipIf(!runActorIntegration)("stars the sandbox agent repo through the github driver", async (t) => {
    const calls: string[] = [];
    const testDriver = createTestDriver({
      github: {
        listPullRequests: async () => [],
        createPr: async () => ({
          number: 1,
          url: "https://github.com/test/repo/pull/1",
        }),
        starRepository: async (repoFullName) => {
          calls.push(repoFullName);
        },
      },
    });
    createTestRuntimeContext(testDriver);

    const { client } = await setupTest(t, registry);
    const ws = await client.workspace.getOrCreate(workspaceKey("alpha"), {
      createWithInput: "alpha",
    });

    const result = await ws.starSandboxAgentRepo({ workspaceId: "alpha" });

    expect(calls).toEqual(["rivet-dev/sandbox-agent"]);
    expect(result.repo).toBe("rivet-dev/sandbox-agent");
    expect(typeof result.starredAt).toBe("number");
  });
});
