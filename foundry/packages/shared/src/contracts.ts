import { z } from "zod";

export const WorkspaceIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/);
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const ProviderIdSchema = z.enum(["daytona", "local"]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const AgentTypeSchema = z.enum(["claude", "codex"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const RepoIdSchema = z.string().min(1).max(128);
export type RepoId = z.infer<typeof RepoIdSchema>;

export const RepoRemoteSchema = z.string().min(1).max(2048);
export type RepoRemote = z.infer<typeof RepoRemoteSchema>;

export const HandoffStatusSchema = z.enum([
  "init_bootstrap_db",
  "init_enqueue_provision",
  "init_ensure_name",
  "init_assert_name",
  "init_create_sandbox",
  "init_ensure_agent",
  "init_start_sandbox_instance",
  "init_create_session",
  "init_write_db",
  "init_start_status_sync",
  "init_complete",
  "running",
  "idle",
  "archive_stop_status_sync",
  "archive_release_sandbox",
  "archive_finalize",
  "archived",
  "kill_destroy_sandbox",
  "kill_finalize",
  "killed",
  "error",
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const RepoRecordSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repoId: RepoIdSchema,
  remoteUrl: RepoRemoteSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type RepoRecord = z.infer<typeof RepoRecordSchema>;

export const AddRepoInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  remoteUrl: RepoRemoteSchema,
});
export type AddRepoInput = z.infer<typeof AddRepoInputSchema>;

export const CreateHandoffInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repoId: RepoIdSchema,
  task: z.string().min(1),
  explicitTitle: z.string().trim().min(1).optional(),
  explicitBranchName: z.string().trim().min(1).optional(),
  providerId: ProviderIdSchema.optional(),
  agentType: AgentTypeSchema.optional(),
  onBranch: z.string().trim().min(1).optional(),
});
export type CreateHandoffInput = z.infer<typeof CreateHandoffInputSchema>;

export const HandoffRecordSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repoId: z.string().min(1),
  repoRemote: RepoRemoteSchema,
  handoffId: z.string().min(1),
  branchName: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  task: z.string().min(1),
  providerId: ProviderIdSchema,
  status: HandoffStatusSchema,
  statusMessage: z.string().nullable(),
  activeSandboxId: z.string().nullable(),
  activeSessionId: z.string().nullable(),
  sandboxes: z.array(
    z.object({
      sandboxId: z.string().min(1),
      providerId: ProviderIdSchema,
      sandboxActorId: z.string().nullable(),
      switchTarget: z.string().min(1),
      cwd: z.string().nullable(),
      createdAt: z.number().int(),
      updatedAt: z.number().int(),
    }),
  ),
  agentType: z.string().nullable(),
  prSubmitted: z.boolean(),
  diffStat: z.string().nullable(),
  prUrl: z.string().nullable(),
  prAuthor: z.string().nullable(),
  ciStatus: z.string().nullable(),
  reviewStatus: z.string().nullable(),
  reviewer: z.string().nullable(),
  conflictsWithMain: z.string().nullable(),
  hasUnpushed: z.string().nullable(),
  parentBranch: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

export const HandoffSummarySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repoId: z.string().min(1),
  handoffId: z.string().min(1),
  branchName: z.string().min(1).nullable(),
  title: z.string().min(1).nullable(),
  status: HandoffStatusSchema,
  updatedAt: z.number().int(),
});
export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

export const HandoffActionInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  handoffId: z.string().min(1),
});
export type HandoffActionInput = z.infer<typeof HandoffActionInputSchema>;

export const SwitchResultSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  handoffId: z.string().min(1),
  providerId: ProviderIdSchema,
  switchTarget: z.string().min(1),
});
export type SwitchResult = z.infer<typeof SwitchResultSchema>;

export const ListHandoffsInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repoId: RepoIdSchema.optional(),
});
export type ListHandoffsInput = z.infer<typeof ListHandoffsInputSchema>;

export const RepoBranchRecordSchema = z.object({
  branchName: z.string().min(1),
  commitSha: z.string().min(1),
  parentBranch: z.string().nullable(),
  trackedInStack: z.boolean(),
  diffStat: z.string().nullable(),
  hasUnpushed: z.boolean(),
  conflictsWithMain: z.boolean(),
  handoffId: z.string().nullable(),
  handoffTitle: z.string().nullable(),
  handoffStatus: HandoffStatusSchema.nullable(),
  prNumber: z.number().int().nullable(),
  prState: z.string().nullable(),
  prUrl: z.string().nullable(),
  ciStatus: z.string().nullable(),
  reviewStatus: z.string().nullable(),
  reviewer: z.string().nullable(),
  firstSeenAt: z.number().int().nullable(),
  lastSeenAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
});
export type RepoBranchRecord = z.infer<typeof RepoBranchRecordSchema>;

export const RepoOverviewSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repoId: RepoIdSchema,
  remoteUrl: RepoRemoteSchema,
  baseRef: z.string().nullable(),
  stackAvailable: z.boolean(),
  fetchedAt: z.number().int(),
  branches: z.array(RepoBranchRecordSchema),
});
export type RepoOverview = z.infer<typeof RepoOverviewSchema>;

export const RepoStackActionSchema = z.enum(["sync_repo", "restack_repo", "restack_subtree", "rebase_branch", "reparent_branch"]);
export type RepoStackAction = z.infer<typeof RepoStackActionSchema>;

export const RepoStackActionInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repoId: RepoIdSchema,
  action: RepoStackActionSchema,
  branchName: z.string().trim().min(1).optional(),
  parentBranch: z.string().trim().min(1).optional(),
});
export type RepoStackActionInput = z.infer<typeof RepoStackActionInputSchema>;

export const RepoStackActionResultSchema = z.object({
  action: RepoStackActionSchema,
  executed: z.boolean(),
  message: z.string().min(1),
  at: z.number().int(),
});
export type RepoStackActionResult = z.infer<typeof RepoStackActionResultSchema>;

export const WorkspaceUseInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});
export type WorkspaceUseInput = z.infer<typeof WorkspaceUseInputSchema>;

export const StarSandboxAgentRepoInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});
export type StarSandboxAgentRepoInput = z.infer<typeof StarSandboxAgentRepoInputSchema>;

export const StarSandboxAgentRepoResultSchema = z.object({
  repo: z.string().min(1),
  starredAt: z.number().int(),
});
export type StarSandboxAgentRepoResult = z.infer<typeof StarSandboxAgentRepoResultSchema>;

export const HistoryQueryInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  limit: z.number().int().positive().max(500).optional(),
  branch: z.string().min(1).optional(),
  handoffId: z.string().min(1).optional(),
});
export type HistoryQueryInput = z.infer<typeof HistoryQueryInputSchema>;

export const HistoryEventSchema = z.object({
  id: z.number().int(),
  workspaceId: WorkspaceIdSchema,
  repoId: z.string().nullable(),
  handoffId: z.string().nullable(),
  branchName: z.string().nullable(),
  kind: z.string().min(1),
  payloadJson: z.string().min(1),
  createdAt: z.number().int(),
});
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const PruneInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  dryRun: z.boolean(),
  yes: z.boolean(),
});
export type PruneInput = z.infer<typeof PruneInputSchema>;

export const KillInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  handoffId: z.string().min(1),
  deleteBranch: z.boolean(),
  abandon: z.boolean(),
});
export type KillInput = z.infer<typeof KillInputSchema>;

export const StatuslineInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  format: z.enum(["table", "claude-code"]),
});
export type StatuslineInput = z.infer<typeof StatuslineInputSchema>;

export const ListInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  format: z.enum(["table", "json"]),
  full: z.boolean(),
});
export type ListInput = z.infer<typeof ListInputSchema>;
