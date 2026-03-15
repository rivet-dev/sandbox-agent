export type ActorKey = string[];

export function organizationKey(organizationId: string): ActorKey {
  return ["org", organizationId];
}

export function repositoryKey(organizationId: string, repoId: string): ActorKey {
  return ["org", organizationId, "repository", repoId];
}

export function taskKey(organizationId: string, repoId: string, taskId: string): ActorKey {
  return ["org", organizationId, "repository", repoId, "task", taskId];
}

export function taskSandboxKey(organizationId: string, sandboxId: string): ActorKey {
  return ["org", organizationId, "sandbox", sandboxId];
}

export function historyKey(organizationId: string, repoId: string): ActorKey {
  return ["org", organizationId, "repository", repoId, "history"];
}
