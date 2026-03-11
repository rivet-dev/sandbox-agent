import { describe, expect, it } from "vitest";
import type { BackendClient } from "../src/backend-client.js";
import { createTaskWorkbenchClient } from "../src/workbench-client.js";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createTaskWorkbenchClient", () => {
  it("scopes mock clients by workspace", async () => {
    const alpha = createTaskWorkbenchClient({
      mode: "mock",
      workspaceId: "mock-alpha",
    });
    const beta = createTaskWorkbenchClient({
      mode: "mock",
      workspaceId: "mock-beta",
    });

    const alphaInitial = alpha.getSnapshot();
    const betaInitial = beta.getSnapshot();
    expect(alphaInitial.workspaceId).toBe("mock-alpha");
    expect(betaInitial.workspaceId).toBe("mock-beta");

    await alpha.createTask({
      repoId: alphaInitial.repos[0]!.id,
      task: "Ship alpha-only change",
      title: "Alpha only",
    });

    expect(alpha.getSnapshot().tasks).toHaveLength(alphaInitial.tasks.length + 1);
    expect(beta.getSnapshot().tasks).toHaveLength(betaInitial.tasks.length);
  });

  it("uses the initial task to bootstrap a new mock task session", async () => {
    const client = createTaskWorkbenchClient({
      mode: "mock",
      workspaceId: "mock-onboarding",
    });
    const snapshot = client.getSnapshot();

    const created = await client.createTask({
      repoId: snapshot.repos[0]!.id,
      task: "Reply with exactly: MOCK_WORKBENCH_READY",
      title: "Mock onboarding",
      branch: "feat/mock-onboarding",
      model: "gpt-4o",
    });

    const runningTask = client.getSnapshot().tasks.find((task) => task.id === created.taskId);
    expect(runningTask).toEqual(
      expect.objectContaining({
        title: "Mock onboarding",
        branch: "feat/mock-onboarding",
        status: "running",
      }),
    );
    expect(runningTask?.tabs[0]).toEqual(
      expect.objectContaining({
        id: created.tabId,
        created: true,
        status: "running",
      }),
    );
    expect(runningTask?.tabs[0]?.transcript).toEqual([
      expect.objectContaining({
        sender: "client",
        payload: expect.objectContaining({
          method: "session/prompt",
        }),
      }),
    ]);

    await sleep(2_700);

    const completedTask = client.getSnapshot().tasks.find((task) => task.id === created.taskId);
    expect(completedTask?.status).toBe("idle");
    expect(completedTask?.tabs[0]).toEqual(
      expect.objectContaining({
        status: "idle",
        unread: true,
      }),
    );
    expect(completedTask?.tabs[0]?.transcript).toEqual([expect.objectContaining({ sender: "client" }), expect.objectContaining({ sender: "agent" })]);
  });

  it("routes remote push actions through the backend boundary", async () => {
    const actions: Array<{ workspaceId: string; taskId: string; action: string }> = [];
    let snapshotReads = 0;
    const backend = {
      async runAction(workspaceId: string, taskId: string, action: string): Promise<void> {
        actions.push({ workspaceId, taskId, action });
      },
      async getWorkbench(workspaceId: string) {
        snapshotReads += 1;
        return {
          workspaceId,
          repos: [],
          projects: [],
          tasks: [],
        };
      },
      subscribeWorkbench(): () => void {
        return () => {};
      },
    } as unknown as BackendClient;

    const client = createTaskWorkbenchClient({
      mode: "remote",
      backend,
      workspaceId: "remote-ws",
    });

    await client.pushTask({ taskId: "task-123" });

    expect(actions).toEqual([
      {
        workspaceId: "remote-ws",
        taskId: "task-123",
        action: "push",
      },
    ]);
    expect(snapshotReads).toBe(1);
  });
});
