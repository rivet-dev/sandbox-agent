import { taskKey, taskStatusSyncKey, historyKey, projectBranchSyncKey, projectKey, projectPrSyncKey, sandboxInstanceKey, workspaceKey } from "./keys.js";
import type { ProviderId } from "@sandbox-agent/foundry-shared";

export function actorClient(c: any) {
  return c.client();
}

export async function getOrCreateWorkspace(c: any, workspaceId: string) {
  return await actorClient(c).workspace.getOrCreate(workspaceKey(workspaceId), {
    createWithInput: workspaceId,
  });
}

export async function getOrCreateProject(c: any, workspaceId: string, repoId: string, remoteUrl: string) {
  return await actorClient(c).project.getOrCreate(projectKey(workspaceId, repoId), {
    createWithInput: {
      workspaceId,
      repoId,
      remoteUrl,
    },
  });
}

export function getProject(c: any, workspaceId: string, repoId: string) {
  return actorClient(c).project.get(projectKey(workspaceId, repoId));
}

export function getTask(c: any, workspaceId: string, repoId: string, taskId: string) {
  return actorClient(c).task.get(taskKey(workspaceId, repoId, taskId));
}

export async function getOrCreateTask(c: any, workspaceId: string, repoId: string, taskId: string, createWithInput: Record<string, unknown>) {
  return await actorClient(c).task.getOrCreate(taskKey(workspaceId, repoId, taskId), {
    createWithInput,
  });
}

export async function getOrCreateHistory(c: any, workspaceId: string, repoId: string) {
  return await actorClient(c).history.getOrCreate(historyKey(workspaceId, repoId), {
    createWithInput: {
      workspaceId,
      repoId,
    },
  });
}

export async function getOrCreateProjectPrSync(c: any, workspaceId: string, repoId: string, repoPath: string, intervalMs: number) {
  return await actorClient(c).projectPrSync.getOrCreate(projectPrSyncKey(workspaceId, repoId), {
    createWithInput: {
      workspaceId,
      repoId,
      repoPath,
      intervalMs,
    },
  });
}

export async function getOrCreateProjectBranchSync(c: any, workspaceId: string, repoId: string, repoPath: string, intervalMs: number) {
  return await actorClient(c).projectBranchSync.getOrCreate(projectBranchSyncKey(workspaceId, repoId), {
    createWithInput: {
      workspaceId,
      repoId,
      repoPath,
      intervalMs,
    },
  });
}

export function getSandboxInstance(c: any, workspaceId: string, providerId: ProviderId, sandboxId: string) {
  return actorClient(c).sandboxInstance.get(sandboxInstanceKey(workspaceId, providerId, sandboxId));
}

export async function getOrCreateSandboxInstance(
  c: any,
  workspaceId: string,
  providerId: ProviderId,
  sandboxId: string,
  createWithInput: Record<string, unknown>,
) {
  return await actorClient(c).sandboxInstance.getOrCreate(sandboxInstanceKey(workspaceId, providerId, sandboxId), { createWithInput });
}

export async function getOrCreateTaskStatusSync(
  c: any,
  workspaceId: string,
  repoId: string,
  taskId: string,
  sandboxId: string,
  sessionId: string,
  createWithInput: Record<string, unknown>,
) {
  return await actorClient(c).taskStatusSync.getOrCreate(taskStatusSyncKey(workspaceId, repoId, taskId, sandboxId, sessionId), {
    createWithInput,
  });
}

export function selfProjectPrSync(c: any) {
  return actorClient(c).projectPrSync.getForId(c.actorId);
}

export function selfProjectBranchSync(c: any) {
  return actorClient(c).projectBranchSync.getForId(c.actorId);
}

export function selfTaskStatusSync(c: any) {
  return actorClient(c).taskStatusSync.getForId(c.actorId);
}

export function selfHistory(c: any) {
  return actorClient(c).history.getForId(c.actorId);
}

export function selfTask(c: any) {
  return actorClient(c).task.getForId(c.actorId);
}

export function selfWorkspace(c: any) {
  return actorClient(c).workspace.getForId(c.actorId);
}

export function selfProject(c: any) {
  return actorClient(c).project.getForId(c.actorId);
}

export function selfSandboxInstance(c: any) {
  return actorClient(c).sandboxInstance.getForId(c.actorId);
}
