import type { TaskWorkbenchClient } from "@sandbox-agent/foundry-client/workbench";
import { createWorkbenchRuntimeClient } from "@workbench-runtime";
import { frontendClientMode } from "./env";
export { resolveRepoRouteTaskId } from "./workbench-routing";

const workbenchClientCache = new Map<string, TaskWorkbenchClient>();

export function getTaskWorkbenchClient(workspaceId: string): TaskWorkbenchClient {
  const cacheKey = `${frontendClientMode}:${workspaceId}`;
  const existing = workbenchClientCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const client = createWorkbenchRuntimeClient(workspaceId);
  workbenchClientCache.set(cacheKey, client);
  return client;
}
