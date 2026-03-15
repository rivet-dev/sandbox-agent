import { authUserKey, githubDataKey, historyKey, organizationKey, repositoryKey, taskKey, taskSandboxKey } from "./keys.js";

export function actorClient(c: any) {
  return c.client();
}

export async function getOrCreateOrganization(c: any, organizationId: string) {
  return await actorClient(c).organization.getOrCreate(organizationKey(organizationId), {
    createWithInput: organizationId,
  });
}

export async function getOrCreateAuthUser(c: any, userId: string) {
  return await actorClient(c).authUser.getOrCreate(authUserKey(userId), {
    createWithInput: { userId },
  });
}

export function getAuthUser(c: any, userId: string) {
  return actorClient(c).authUser.get(authUserKey(userId));
}

export async function getOrCreateRepository(c: any, organizationId: string, repoId: string, remoteUrl: string) {
  return await actorClient(c).repository.getOrCreate(repositoryKey(organizationId, repoId), {
    createWithInput: {
      organizationId,
      repoId,
      remoteUrl,
    },
  });
}

export function getRepository(c: any, organizationId: string, repoId: string) {
  return actorClient(c).repository.get(repositoryKey(organizationId, repoId));
}

export function getTask(c: any, organizationId: string, repoId: string, taskId: string) {
  return actorClient(c).task.get(taskKey(organizationId, repoId, taskId));
}

export async function getOrCreateTask(c: any, organizationId: string, repoId: string, taskId: string, createWithInput: Record<string, unknown>) {
  return await actorClient(c).task.getOrCreate(taskKey(organizationId, repoId, taskId), {
    createWithInput,
  });
}

export async function getOrCreateHistory(c: any, organizationId: string, repoId: string) {
  return await actorClient(c).history.getOrCreate(historyKey(organizationId, repoId), {
    createWithInput: {
      organizationId,
      repoId,
    },
  });
}

export async function getOrCreateGithubData(c: any, organizationId: string) {
  return await actorClient(c).githubData.getOrCreate(githubDataKey(organizationId), {
    createWithInput: {
      organizationId,
    },
  });
}

export function getGithubData(c: any, organizationId: string) {
  return actorClient(c).githubData.get(githubDataKey(organizationId));
}

export function getTaskSandbox(c: any, organizationId: string, sandboxId: string) {
  return actorClient(c).taskSandbox.get(taskSandboxKey(organizationId, sandboxId));
}

export async function getOrCreateTaskSandbox(c: any, organizationId: string, sandboxId: string, createWithInput?: Record<string, unknown>) {
  return await actorClient(c).taskSandbox.getOrCreate(taskSandboxKey(organizationId, sandboxId), {
    createWithInput,
  });
}

export function selfHistory(c: any) {
  return actorClient(c).history.getForId(c.actorId);
}

export function selfTask(c: any) {
  return actorClient(c).task.getForId(c.actorId);
}

export function selfOrganization(c: any) {
  return actorClient(c).organization.getForId(c.actorId);
}

export function selfRepository(c: any) {
  return actorClient(c).repository.getForId(c.actorId);
}

export function selfAuthUser(c: any) {
  return actorClient(c).authUser.getForId(c.actorId);
}

export function selfGithubData(c: any) {
  return actorClient(c).githubData.getForId(c.actorId);
}
