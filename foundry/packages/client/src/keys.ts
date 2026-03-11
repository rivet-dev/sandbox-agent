export type ActorKey = string[];

export function workspaceKey(workspaceId: string): ActorKey {
  return ["ws", workspaceId];
}

export function projectKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "project", repoId];
}

export function handoffKey(workspaceId: string, repoId: string, handoffId: string): ActorKey {
  return ["ws", workspaceId, "project", repoId, "handoff", handoffId];
}

export function sandboxInstanceKey(workspaceId: string, providerId: string, sandboxId: string): ActorKey {
  return ["ws", workspaceId, "provider", providerId, "sandbox", sandboxId];
}

export function historyKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "project", repoId, "history"];
}

export function projectPrSyncKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "project", repoId, "pr-sync"];
}

export function projectBranchSyncKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "project", repoId, "branch-sync"];
}

export function handoffStatusSyncKey(workspaceId: string, repoId: string, handoffId: string, sandboxId: string, sessionId: string): ActorKey {
  // Include sandbox + session so multiple sandboxes/sessions can be tracked per handoff.
  return ["ws", workspaceId, "project", repoId, "handoff", handoffId, "status-sync", sandboxId, sessionId];
}
