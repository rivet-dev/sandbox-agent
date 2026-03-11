// @ts-nocheck
import { desc, eq } from "drizzle-orm";
import { Loop } from "rivetkit/workflow";
import type {
  AddRepoInput,
  CreateTaskInput,
  TaskRecord,
  TaskSummary,
  TaskWorkbenchChangeModelInput,
  TaskWorkbenchCreateTaskInput,
  TaskWorkbenchDiffInput,
  TaskWorkbenchRenameInput,
  TaskWorkbenchRenameSessionInput,
  TaskWorkbenchSelectInput,
  TaskWorkbenchSetSessionUnreadInput,
  TaskWorkbenchSendMessageInput,
  TaskWorkbenchSnapshot,
  TaskWorkbenchTabInput,
  TaskWorkbenchUpdateDraftInput,
  HistoryEvent,
  HistoryQueryInput,
  ListTasksInput,
  ProviderId,
  RepoOverview,
  RepoStackActionInput,
  RepoStackActionResult,
  RepoRecord,
  StarSandboxAgentRepoInput,
  StarSandboxAgentRepoResult,
  SwitchResult,
  WorkspaceUseInput,
} from "@sandbox-agent/foundry-shared";
import { getActorRuntimeContext } from "../context.js";
import { getTask, getOrCreateHistory, getOrCreateProject, selfWorkspace } from "../handles.js";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { normalizeRemoteUrl, repoIdFromRemote } from "../../services/repo.js";
import { taskLookup, repos, providerProfiles } from "./db/schema.js";
import { agentTypeForModel } from "../task/workbench.js";
import { expectQueueResponse } from "../../services/queue.js";
import { workspaceAppActions } from "./app-shell.js";

interface WorkspaceState {
  workspaceId: string;
}

interface RefreshProviderProfilesCommand {
  providerId?: ProviderId;
}

interface GetTaskInput {
  workspaceId: string;
  taskId: string;
}

interface TaskProxyActionInput extends GetTaskInput {
  reason?: string;
}

interface RepoOverviewInput {
  workspaceId: string;
  repoId: string;
}

const WORKSPACE_QUEUE_NAMES = ["workspace.command.addRepo", "workspace.command.createTask", "workspace.command.refreshProviderProfiles"] as const;
const SANDBOX_AGENT_REPO = "rivet-dev/sandbox-agent";

type WorkspaceQueueName = (typeof WORKSPACE_QUEUE_NAMES)[number];

export { WORKSPACE_QUEUE_NAMES };

export function workspaceWorkflowQueueName(name: WorkspaceQueueName): WorkspaceQueueName {
  return name;
}

function assertWorkspace(c: { state: WorkspaceState }, workspaceId: string): void {
  if (workspaceId !== c.state.workspaceId) {
    throw new Error(`Workspace actor mismatch: actor=${c.state.workspaceId} command=${workspaceId}`);
  }
}

async function resolveRepoId(c: any, taskId: string): Promise<string> {
  const row = await c.db.select({ repoId: taskLookup.repoId }).from(taskLookup).where(eq(taskLookup.taskId, taskId)).get();

  if (!row) {
    throw new Error(`Unknown task: ${taskId} (not in lookup)`);
  }

  return row.repoId;
}

async function upsertTaskLookupRow(c: any, taskId: string, repoId: string): Promise<void> {
  await c.db
    .insert(taskLookup)
    .values({
      taskId,
      repoId,
    })
    .onConflictDoUpdate({
      target: taskLookup.taskId,
      set: { repoId },
    })
    .run();
}

async function collectAllTaskSummaries(c: any): Promise<TaskSummary[]> {
  const repoRows = await c.db.select({ repoId: repos.repoId, remoteUrl: repos.remoteUrl }).from(repos).orderBy(desc(repos.updatedAt)).all();

  const all: TaskSummary[] = [];
  for (const row of repoRows) {
    try {
      const project = await getOrCreateProject(c, c.state.workspaceId, row.repoId, row.remoteUrl);
      const snapshot = await project.listTaskSummaries({ includeArchived: true });
      all.push(...snapshot);
    } catch (error) {
      logActorWarning("workspace", "failed collecting tasks for repo", {
        workspaceId: c.state.workspaceId,
        repoId: row.repoId,
        error: resolveErrorMessage(error),
      });
    }
  }

  all.sort((a, b) => b.updatedAt - a.updatedAt);
  return all;
}

function repoLabelFromRemote(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl.startsWith("http") ? remoteUrl : `https://${remoteUrl}`);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/, "")}`;
    }
  } catch {
    // ignore
  }

  return remoteUrl;
}

async function buildWorkbenchSnapshot(c: any): Promise<TaskWorkbenchSnapshot> {
  const repoRows = await c.db
    .select({ repoId: repos.repoId, remoteUrl: repos.remoteUrl, updatedAt: repos.updatedAt })
    .from(repos)
    .orderBy(desc(repos.updatedAt))
    .all();

  const tasks: Array<any> = [];
  const projects: Array<any> = [];
  for (const row of repoRows) {
    const projectTasks: Array<any> = [];
    try {
      const project = await getOrCreateProject(c, c.state.workspaceId, row.repoId, row.remoteUrl);
      const summaries = await project.listTaskSummaries({ includeArchived: true });
      for (const summary of summaries) {
        try {
          await upsertTaskLookupRow(c, summary.taskId, row.repoId);
          const task = getTask(c, c.state.workspaceId, row.repoId, summary.taskId);
          const snapshot = await task.getWorkbench({});
          tasks.push(snapshot);
          projectTasks.push(snapshot);
        } catch (error) {
          logActorWarning("workspace", "failed collecting workbench task", {
            workspaceId: c.state.workspaceId,
            repoId: row.repoId,
            taskId: summary.taskId,
            error: resolveErrorMessage(error),
          });
        }
      }

      if (projectTasks.length > 0) {
        projects.push({
          id: row.repoId,
          label: repoLabelFromRemote(row.remoteUrl),
          updatedAtMs: projectTasks[0]?.updatedAtMs ?? row.updatedAt,
          tasks: projectTasks.sort((left, right) => right.updatedAtMs - left.updatedAtMs),
        });
      }
    } catch (error) {
      logActorWarning("workspace", "failed collecting workbench repo snapshot", {
        workspaceId: c.state.workspaceId,
        repoId: row.repoId,
        error: resolveErrorMessage(error),
      });
    }
  }

  tasks.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  projects.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return {
    workspaceId: c.state.workspaceId,
    repos: repoRows.map((row) => ({
      id: row.repoId,
      label: repoLabelFromRemote(row.remoteUrl),
    })),
    projects,
    tasks,
  };
}

async function requireWorkbenchTask(c: any, taskId: string) {
  const repoId = await resolveRepoId(c, taskId);
  return getTask(c, c.state.workspaceId, repoId, taskId);
}

async function addRepoMutation(c: any, input: AddRepoInput): Promise<RepoRecord> {
  assertWorkspace(c, input.workspaceId);

  const remoteUrl = normalizeRemoteUrl(input.remoteUrl);
  if (!remoteUrl) {
    throw new Error("remoteUrl is required");
  }

  const { driver } = getActorRuntimeContext();
  await driver.git.validateRemote(remoteUrl);

  const repoId = repoIdFromRemote(remoteUrl);
  const now = Date.now();

  await c.db
    .insert(repos)
    .values({
      repoId,
      remoteUrl,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: repos.repoId,
      set: {
        remoteUrl,
        updatedAt: now,
      },
    })
    .run();

  await workspaceActions.notifyWorkbenchUpdated(c);
  return {
    workspaceId: c.state.workspaceId,
    repoId,
    remoteUrl,
    createdAt: now,
    updatedAt: now,
  };
}

async function createTaskMutation(c: any, input: CreateTaskInput): Promise<TaskRecord> {
  assertWorkspace(c, input.workspaceId);

  const { providers } = getActorRuntimeContext();
  const providerId = input.providerId ?? providers.defaultProviderId();

  const repoId = input.repoId;
  const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, repoId)).get();
  if (!repoRow) {
    throw new Error(`Unknown repo: ${repoId}`);
  }
  const remoteUrl = repoRow.remoteUrl;

  await c.db
    .insert(providerProfiles)
    .values({
      providerId,
      profileJson: JSON.stringify({ providerId }),
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: providerProfiles.providerId,
      set: {
        profileJson: JSON.stringify({ providerId }),
        updatedAt: Date.now(),
      },
    })
    .run();

  const project = await getOrCreateProject(c, c.state.workspaceId, repoId, remoteUrl);
  await project.ensure({ remoteUrl });

  const created = await project.createTask({
    task: input.task,
    providerId,
    agentType: input.agentType ?? null,
    explicitTitle: input.explicitTitle ?? null,
    explicitBranchName: input.explicitBranchName ?? null,
    onBranch: input.onBranch ?? null,
  });

  await c.db
    .insert(taskLookup)
    .values({
      taskId: created.taskId,
      repoId,
    })
    .onConflictDoUpdate({
      target: taskLookup.taskId,
      set: { repoId },
    })
    .run();

  const task = getTask(c, c.state.workspaceId, repoId, created.taskId);
  await task.provision({ providerId });

  await workspaceActions.notifyWorkbenchUpdated(c);
  return created;
}

async function refreshProviderProfilesMutation(c: any, command?: RefreshProviderProfilesCommand): Promise<void> {
  const body = command ?? {};
  const { providers } = getActorRuntimeContext();
  const providerIds: ProviderId[] = body.providerId ? [body.providerId] : providers.availableProviderIds();

  for (const providerId of providerIds) {
    await c.db
      .insert(providerProfiles)
      .values({
        providerId,
        profileJson: JSON.stringify({ providerId }),
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: providerProfiles.providerId,
        set: {
          profileJson: JSON.stringify({ providerId }),
          updatedAt: Date.now(),
        },
      })
      .run();
  }
}

export async function runWorkspaceWorkflow(ctx: any): Promise<void> {
  await ctx.loop("workspace-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-workspace-command", {
      names: [...WORKSPACE_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }

    if (msg.name === "workspace.command.addRepo") {
      const result = await loopCtx.step({
        name: "workspace-add-repo",
        timeout: 60_000,
        run: async () => addRepoMutation(loopCtx, msg.body as AddRepoInput),
      });
      await msg.complete(result);
      return Loop.continue(undefined);
    }

    if (msg.name === "workspace.command.createTask") {
      const result = await loopCtx.step({
        name: "workspace-create-task",
        timeout: 12 * 60_000,
        run: async () => createTaskMutation(loopCtx, msg.body as CreateTaskInput),
      });
      await msg.complete(result);
      return Loop.continue(undefined);
    }

    if (msg.name === "workspace.command.refreshProviderProfiles") {
      await loopCtx.step("workspace-refresh-provider-profiles", async () =>
        refreshProviderProfilesMutation(loopCtx, msg.body as RefreshProviderProfilesCommand),
      );
      await msg.complete({ ok: true });
    }

    return Loop.continue(undefined);
  });
}

export const workspaceActions = {
  ...workspaceAppActions,
  async useWorkspace(c: any, input: WorkspaceUseInput): Promise<{ workspaceId: string }> {
    assertWorkspace(c, input.workspaceId);
    return { workspaceId: c.state.workspaceId };
  },

  async addRepo(c: any, input: AddRepoInput): Promise<RepoRecord> {
    const self = selfWorkspace(c);
    return expectQueueResponse<RepoRecord>(
      await self.send(workspaceWorkflowQueueName("workspace.command.addRepo"), input, {
        wait: true,
        timeout: 60_000,
      }),
    );
  },

  async listRepos(c: any, input: WorkspaceUseInput): Promise<RepoRecord[]> {
    assertWorkspace(c, input.workspaceId);

    const rows = await c.db
      .select({
        repoId: repos.repoId,
        remoteUrl: repos.remoteUrl,
        createdAt: repos.createdAt,
        updatedAt: repos.updatedAt,
      })
      .from(repos)
      .orderBy(desc(repos.updatedAt))
      .all();

    return rows.map((row) => ({
      workspaceId: c.state.workspaceId,
      repoId: row.repoId,
      remoteUrl: row.remoteUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },

  async createTask(c: any, input: CreateTaskInput): Promise<TaskRecord> {
    const self = selfWorkspace(c);
    return expectQueueResponse<TaskRecord>(
      await self.send(workspaceWorkflowQueueName("workspace.command.createTask"), input, {
        wait: true,
        timeout: 12 * 60_000,
      }),
    );
  },

  async starSandboxAgentRepo(c: any, input: StarSandboxAgentRepoInput): Promise<StarSandboxAgentRepoResult> {
    assertWorkspace(c, input.workspaceId);
    const { driver } = getActorRuntimeContext();
    await driver.github.starRepository(SANDBOX_AGENT_REPO);
    return {
      repo: SANDBOX_AGENT_REPO,
      starredAt: Date.now(),
    };
  },

  async getWorkbench(c: any, input: WorkspaceUseInput): Promise<TaskWorkbenchSnapshot> {
    assertWorkspace(c, input.workspaceId);
    return await buildWorkbenchSnapshot(c);
  },

  async notifyWorkbenchUpdated(c: any): Promise<void> {
    c.broadcast("workbenchUpdated", { at: Date.now() });
  },

  async createWorkbenchTask(c: any, input: TaskWorkbenchCreateTaskInput): Promise<{ taskId: string }> {
    const created = await workspaceActions.createTask(c, {
      workspaceId: c.state.workspaceId,
      repoId: input.repoId,
      task: input.task,
      ...(input.title ? { explicitTitle: input.title } : {}),
      ...(input.branch ? { explicitBranchName: input.branch } : {}),
      ...(input.model ? { agentType: agentTypeForModel(input.model) } : {}),
    });
    return { taskId: created.taskId };
  },

  async markWorkbenchUnread(c: any, input: TaskWorkbenchSelectInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.markWorkbenchUnread({});
  },

  async renameWorkbenchTask(c: any, input: TaskWorkbenchRenameInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.renameWorkbenchTask(input);
  },

  async renameWorkbenchBranch(c: any, input: TaskWorkbenchRenameInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.renameWorkbenchBranch(input);
  },

  async createWorkbenchSession(c: any, input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ tabId: string }> {
    const task = await requireWorkbenchTask(c, input.taskId);
    return await task.createWorkbenchSession({ ...(input.model ? { model: input.model } : {}) });
  },

  async renameWorkbenchSession(c: any, input: TaskWorkbenchRenameSessionInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.renameWorkbenchSession(input);
  },

  async setWorkbenchSessionUnread(c: any, input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.setWorkbenchSessionUnread(input);
  },

  async updateWorkbenchDraft(c: any, input: TaskWorkbenchUpdateDraftInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.updateWorkbenchDraft(input);
  },

  async changeWorkbenchModel(c: any, input: TaskWorkbenchChangeModelInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.changeWorkbenchModel(input);
  },

  async sendWorkbenchMessage(c: any, input: TaskWorkbenchSendMessageInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.sendWorkbenchMessage(input);
  },

  async stopWorkbenchSession(c: any, input: TaskWorkbenchTabInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.stopWorkbenchSession(input);
  },

  async closeWorkbenchSession(c: any, input: TaskWorkbenchTabInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.closeWorkbenchSession(input);
  },

  async publishWorkbenchPr(c: any, input: TaskWorkbenchSelectInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.publishWorkbenchPr({});
  },

  async revertWorkbenchFile(c: any, input: TaskWorkbenchDiffInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.revertWorkbenchFile(input);
  },

  async listTasks(c: any, input: ListTasksInput): Promise<TaskSummary[]> {
    assertWorkspace(c, input.workspaceId);

    if (input.repoId) {
      const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, input.repoId)).get();
      if (!repoRow) {
        throw new Error(`Unknown repo: ${input.repoId}`);
      }

      const project = await getOrCreateProject(c, c.state.workspaceId, input.repoId, repoRow.remoteUrl);
      return await project.listTaskSummaries({ includeArchived: true });
    }

    return await collectAllTaskSummaries(c);
  },

  async getRepoOverview(c: any, input: RepoOverviewInput): Promise<RepoOverview> {
    assertWorkspace(c, input.workspaceId);

    const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, input.repoId)).get();
    if (!repoRow) {
      throw new Error(`Unknown repo: ${input.repoId}`);
    }

    const project = await getOrCreateProject(c, c.state.workspaceId, input.repoId, repoRow.remoteUrl);
    await project.ensure({ remoteUrl: repoRow.remoteUrl });
    return await project.getRepoOverview({});
  },

  async runRepoStackAction(c: any, input: RepoStackActionInput): Promise<RepoStackActionResult> {
    assertWorkspace(c, input.workspaceId);

    const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, input.repoId)).get();
    if (!repoRow) {
      throw new Error(`Unknown repo: ${input.repoId}`);
    }

    const project = await getOrCreateProject(c, c.state.workspaceId, input.repoId, repoRow.remoteUrl);
    await project.ensure({ remoteUrl: repoRow.remoteUrl });
    return await project.runRepoStackAction({
      action: input.action,
      branchName: input.branchName,
      parentBranch: input.parentBranch,
    });
  },

  async switchTask(c: any, taskId: string): Promise<SwitchResult> {
    const repoId = await resolveRepoId(c, taskId);
    const h = getTask(c, c.state.workspaceId, repoId, taskId);
    const record = await h.get();
    const switched = await h.switch();

    return {
      workspaceId: c.state.workspaceId,
      taskId,
      providerId: record.providerId,
      switchTarget: switched.switchTarget,
    };
  },

  async refreshProviderProfiles(c: any, command?: RefreshProviderProfilesCommand): Promise<void> {
    const self = selfWorkspace(c);
    await self.send(workspaceWorkflowQueueName("workspace.command.refreshProviderProfiles"), command ?? {}, {
      wait: true,
      timeout: 60_000,
    });
  },

  async history(c: any, input: HistoryQueryInput): Promise<HistoryEvent[]> {
    assertWorkspace(c, input.workspaceId);

    const limit = input.limit ?? 20;
    const repoRows = await c.db.select({ repoId: repos.repoId }).from(repos).all();

    const allEvents: HistoryEvent[] = [];

    for (const row of repoRows) {
      try {
        const hist = await getOrCreateHistory(c, c.state.workspaceId, row.repoId);
        const items = await hist.list({
          branch: input.branch,
          taskId: input.taskId,
          limit,
        });
        allEvents.push(...items);
      } catch (error) {
        logActorWarning("workspace", "history lookup failed for repo", {
          workspaceId: c.state.workspaceId,
          repoId: row.repoId,
          error: resolveErrorMessage(error),
        });
      }
    }

    allEvents.sort((a, b) => b.createdAt - a.createdAt);
    return allEvents.slice(0, limit);
  },

  async getTask(c: any, input: GetTaskInput): Promise<TaskRecord> {
    assertWorkspace(c, input.workspaceId);

    const repoId = await resolveRepoId(c, input.taskId);

    const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, repoId)).get();
    if (!repoRow) {
      throw new Error(`Unknown repo: ${repoId}`);
    }

    const project = await getOrCreateProject(c, c.state.workspaceId, repoId, repoRow.remoteUrl);
    return await project.getTaskEnriched({ taskId: input.taskId });
  },

  async attachTask(c: any, input: TaskProxyActionInput): Promise<{ target: string; sessionId: string | null }> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.workspaceId, repoId, input.taskId);
    return await h.attach({ reason: input.reason });
  },

  async pushTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.workspaceId, repoId, input.taskId);
    await h.push({ reason: input.reason });
  },

  async syncTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.workspaceId, repoId, input.taskId);
    await h.sync({ reason: input.reason });
  },

  async mergeTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.workspaceId, repoId, input.taskId);
    await h.merge({ reason: input.reason });
  },

  async archiveTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.workspaceId, repoId, input.taskId);
    await h.archive({ reason: input.reason });
  },

  async killTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.workspaceId, repoId, input.taskId);
    await h.kill({ reason: input.reason });
  },
};
