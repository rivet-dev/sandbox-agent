import type { HandoffStatus, ProviderId } from "@sandbox-agent/foundry-shared";

export interface HandoffCreatedEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  providerId: ProviderId;
  branchName: string;
  title: string;
}

export interface HandoffStatusEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  status: HandoffStatus;
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
  handoffId: string;
  sessionId: string;
}

export interface AgentIdleEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  sessionId: string;
}

export interface AgentErrorEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  message: string;
}

export interface PrCreatedEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  prNumber: number;
  url: string;
}

export interface PrClosedEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  prNumber: number;
  merged: boolean;
}

export interface PrReviewEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  prNumber: number;
  reviewer: string;
  status: string;
}

export interface CiStatusChangedEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  prNumber: number;
  status: string;
}

export type HandoffStepName = "auto_commit" | "push" | "pr_submit";
export type HandoffStepStatus = "started" | "completed" | "skipped" | "failed";

export interface HandoffStepEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  step: HandoffStepName;
  status: HandoffStepStatus;
  message: string;
}

export interface BranchSwitchedEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  branchName: string;
}

export interface SessionAttachedEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  sessionId: string;
}

export interface BranchSyncedEvent {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  branchName: string;
  strategy: string;
}
