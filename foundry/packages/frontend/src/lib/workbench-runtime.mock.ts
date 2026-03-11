import { createTaskWorkbenchClient, type TaskWorkbenchClient } from "@sandbox-agent/foundry-client/workbench";

export function createWorkbenchRuntimeClient(workspaceId: string): TaskWorkbenchClient {
  return createTaskWorkbenchClient({
    mode: "mock",
    workspaceId,
  });
}
