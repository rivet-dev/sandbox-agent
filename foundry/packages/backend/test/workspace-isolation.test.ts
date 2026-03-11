// @ts-nocheck
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { setupTest } from "rivetkit/test";
import { workspaceKey } from "../src/actors/keys.js";
import { registry } from "../src/actors/index.js";
import { createTestDriver } from "./helpers/test-driver.js";
import { createTestRuntimeContext } from "./helpers/test-context.js";

const runActorIntegration = process.env.HF_ENABLE_ACTOR_INTEGRATION_TESTS === "1";

function createRepo(): { repoPath: string } {
  const repoPath = mkdtempSync(join(tmpdir(), "hf-isolation-repo-"));
  execFileSync("git", ["init"], { cwd: repoPath });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  execFileSync("git", ["config", "user.name", "Foundry Test"], { cwd: repoPath });
  writeFileSync(join(repoPath, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath });
  return { repoPath };
}

async function waitForWorkspaceRows(ws: any, workspaceId: string, expectedCount: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await ws.listTasks({ workspaceId });
    if (rows.length >= expectedCount) {
      return rows;
    }
    await delay(50);
  }
  return ws.listTasks({ workspaceId });
}

describe("workspace isolation", () => {
  it.skipIf(!runActorIntegration)("keeps task lists isolated by workspace", async (t) => {
    const testDriver = createTestDriver();
    createTestRuntimeContext(testDriver);

    const { client } = await setupTest(t, registry);
    const wsA = await client.workspace.getOrCreate(workspaceKey("alpha"), {
      createWithInput: "alpha",
    });
    const wsB = await client.workspace.getOrCreate(workspaceKey("beta"), {
      createWithInput: "beta",
    });

    const { repoPath } = createRepo();
    const repoA = await wsA.addRepo({ workspaceId: "alpha", remoteUrl: repoPath });
    const repoB = await wsB.addRepo({ workspaceId: "beta", remoteUrl: repoPath });

    await wsA.createTask({
      workspaceId: "alpha",
      repoId: repoA.repoId,
      task: "task A",
      providerId: "daytona",
      explicitBranchName: "feature/a",
      explicitTitle: "A",
    });

    await wsB.createTask({
      workspaceId: "beta",
      repoId: repoB.repoId,
      task: "task B",
      providerId: "daytona",
      explicitBranchName: "feature/b",
      explicitTitle: "B",
    });

    const aRows = await waitForWorkspaceRows(wsA, "alpha", 1);
    const bRows = await waitForWorkspaceRows(wsB, "beta", 1);

    expect(aRows.length).toBe(1);
    expect(bRows.length).toBe(1);
    expect(aRows[0]?.workspaceId).toBe("alpha");
    expect(bRows[0]?.workspaceId).toBe("beta");
    expect(aRows[0]?.taskId).not.toBe(bRows[0]?.taskId);
  });
});
