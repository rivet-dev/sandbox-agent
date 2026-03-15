import type { TaskStatus, SandboxProviderId } from "@sandbox-agent/foundry-shared";

export interface TaskCreatedEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  sandboxProviderId: SandboxProviderId;
  branchName: string;
  title: string;
}

export interface TaskStatusEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  status: TaskStatus;
  message: string;
}

export interface RepositorySnapshotEvent {
  organizationId: string;
  repoId: string;
  updatedAt: number;
}

export interface AgentStartedEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}

export interface AgentIdleEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}

export interface AgentErrorEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  message: string;
}

export interface PrCreatedEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  url: string;
}

export interface PrClosedEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  merged: boolean;
}

export interface PrReviewEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  reviewer: string;
  status: string;
}

export interface CiStatusChangedEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  prNumber: number;
  status: string;
}

export type TaskStepName = "auto_commit" | "push" | "pr_submit";
export type TaskStepStatus = "started" | "completed" | "skipped" | "failed";

export interface TaskStepEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  step: TaskStepName;
  status: TaskStepStatus;
  message: string;
}

export interface BranchSwitchedEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  branchName: string;
}

export interface SessionAttachedEvent {
  organizationId: string;
  repoId: string;
  taskId: string;
  sessionId: string;
}
