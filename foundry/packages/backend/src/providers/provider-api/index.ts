import type { ProviderId } from "@sandbox-agent/foundry-shared";

export interface ProviderCapabilities {
  remote: boolean;
  supportsSessionReuse: boolean;
}

export interface CreateSandboxRequest {
  workspaceId: string;
  repoId: string;
  repoRemote: string;
  branchName: string;
  taskId: string;
  debug?: (message: string, context?: Record<string, unknown>) => void;
  options?: Record<string, unknown>;
}

export interface ResumeSandboxRequest {
  workspaceId: string;
  sandboxId: string;
  options?: Record<string, unknown>;
}

export interface DestroySandboxRequest {
  workspaceId: string;
  sandboxId: string;
}

export interface ReleaseSandboxRequest {
  workspaceId: string;
  sandboxId: string;
}

export interface EnsureAgentRequest {
  workspaceId: string;
  sandboxId: string;
}

export interface SandboxHealthRequest {
  workspaceId: string;
  sandboxId: string;
}

export interface AttachTargetRequest {
  workspaceId: string;
  sandboxId: string;
}

export interface ExecuteSandboxCommandRequest {
  workspaceId: string;
  sandboxId: string;
  command: string;
  label?: string;
}

export interface SandboxHandle {
  sandboxId: string;
  switchTarget: string;
  metadata: Record<string, unknown>;
}

export interface AgentEndpoint {
  endpoint: string;
  token?: string;
}

export interface SandboxHealth {
  status: "healthy" | "degraded" | "down";
  message: string;
}

export interface AttachTarget {
  target: string;
}

export interface ExecuteSandboxCommandResult {
  exitCode: number;
  result: string;
}

export interface SandboxProvider {
  id(): ProviderId;
  capabilities(): ProviderCapabilities;
  validateConfig(input: unknown): Promise<Record<string, unknown>>;

  createSandbox(req: CreateSandboxRequest): Promise<SandboxHandle>;
  resumeSandbox(req: ResumeSandboxRequest): Promise<SandboxHandle>;
  destroySandbox(req: DestroySandboxRequest): Promise<void>;
  /**
   * Release resources for a sandbox without deleting its filesystem/state.
   * For remote providers, this typically maps to "stop"/"suspend".
   */
  releaseSandbox(req: ReleaseSandboxRequest): Promise<void>;

  ensureSandboxAgent(req: EnsureAgentRequest): Promise<AgentEndpoint>;
  health(req: SandboxHealthRequest): Promise<SandboxHealth>;
  attachTarget(req: AttachTargetRequest): Promise<AttachTarget>;
  executeCommand(req: ExecuteSandboxCommandRequest): Promise<ExecuteSandboxCommandResult>;
}
