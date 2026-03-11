import { createTaskWorkbenchClient } from "@sandbox-agent/foundry-client";
import { backendClient } from "./backend";
import { defaultWorkspaceId, frontendClientMode } from "./env";

export const taskWorkbenchClient = createTaskWorkbenchClient({
  mode: frontendClientMode,
  backend: backendClient,
  workspaceId: defaultWorkspaceId,
});
