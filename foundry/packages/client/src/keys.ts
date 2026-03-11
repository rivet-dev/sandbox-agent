export type ActorKey = string[];

export function workspaceKey(workspaceId: string): ActorKey {
  return ["ws", workspaceId];
}

export function repoKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "repo", repoId];
}

export function taskKey(workspaceId: string, taskId: string): ActorKey {
  return ["ws", workspaceId, "task", taskId];
}

export function sandboxInstanceKey(workspaceId: string, providerId: string, sandboxId: string): ActorKey {
  return ["ws", workspaceId, "provider", providerId, "sandbox", sandboxId];
}

export function historyKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "repo", repoId, "history"];
}

export function repoPrSyncKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "repo", repoId, "pr-sync"];
}

export function repoBranchSyncKey(workspaceId: string, repoId: string): ActorKey {
  return ["ws", workspaceId, "repo", repoId, "branch-sync"];
}

export function taskStatusSyncKey(workspaceId: string, repoId: string, taskId: string, sandboxId: string, sessionId: string): ActorKey {
  // Include sandbox + session so multiple sandboxes/sessions can be tracked per task.
  return ["ws", workspaceId, "task", taskId, "status-sync", repoId, sandboxId, sessionId];
}
