import type { TaskStatus, ProviderId } from "@sandbox-agent/foundry-shared";

export interface TaskCreatedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  providerId: ProviderId;
  branchName: string;
  title: string;
}

export interface TaskStatusEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  status: TaskStatus;
  message: string;
}

export interface ProjectSnapshotEvent {
  workspaceId: string;
  repoId: string;
  updatedAt: number;
}

export interface AgentStartedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}

export interface AgentIdleEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}

export interface AgentErrorEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  message: string;
}

export interface PrCreatedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  url: string;
}

export interface PrClosedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  merged: boolean;
}

export interface PrReviewEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  reviewer: string;
  status: string;
}

export interface CiStatusChangedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  status: string;
}

export type TaskStepName = "auto_commit" | "push" | "pr_submit";
export type TaskStepStatus = "started" | "completed" | "skipped" | "failed";

export interface TaskStepEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  step: TaskStepName;
  status: TaskStepStatus;
  message: string;
}

export interface BranchSwitchedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  branchName: string;
}

export interface SessionAttachedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}

export interface BranchSyncedEvent {
  workspaceId: string;
  repoId: string;
  taskId: string;
  branchName: string;
  strategy: string;
}
