import { createTaskWorkbenchClient, type TaskWorkbenchClient } from "@sandbox-agent/foundry-client/workbench";
import { backendClient } from "./backend";

export function createWorkbenchRuntimeClient(workspaceId: string): TaskWorkbenchClient {
  return createTaskWorkbenchClient({
    mode: "remote",
    backend: backendClient,
    workspaceId,
  });
}
