// @ts-nocheck
import { desc, eq } from "drizzle-orm";
import { Loop } from "rivetkit/workflow";
import type {
  CreateTaskInput,
  HistoryEvent,
  HistoryQueryInput,
  ListTasksInput,
  SandboxProviderId,
  RepoOverview,
  RepoRecord,
  StarSandboxAgentRepoInput,
  StarSandboxAgentRepoResult,
  SwitchResult,
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
  TaskWorkbenchSessionInput,
  TaskWorkbenchUpdateDraftInput,
  WorkbenchOpenPrSummary,
  WorkbenchRepositorySummary,
  WorkbenchSessionSummary,
  WorkbenchTaskSummary,
  OrganizationEvent,
  OrganizationSummarySnapshot,
  OrganizationUseInput,
} from "@sandbox-agent/foundry-shared";
import { getActorRuntimeContext } from "../context.js";
import { getGithubData, getOrCreateGithubData, getTask, getOrCreateHistory, getOrCreateRepository, selfOrganization } from "../handles.js";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { defaultSandboxProviderId } from "../../sandbox-config.js";
import { repoIdFromRemote } from "../../services/repo.js";
import { resolveOrganizationGithubAuth } from "../../services/github-auth.js";
import { organizationProfile, taskLookup, repos, taskSummaries } from "./db/schema.js";
import { agentTypeForModel } from "../task/workbench.js";
import { expectQueueResponse } from "../../services/queue.js";
import { organizationAppActions } from "./app-shell.js";

interface OrganizationState {
  organizationId: string;
}

interface GetTaskInput {
  organizationId: string;
  taskId: string;
}

interface TaskProxyActionInput extends GetTaskInput {
  reason?: string;
}

interface RepoOverviewInput {
  organizationId: string;
  repoId: string;
}

const ORGANIZATION_QUEUE_NAMES = ["organization.command.createTask", "organization.command.syncGithubSession"] as const;
const SANDBOX_AGENT_REPO = "rivet-dev/sandbox-agent";

type OrganizationQueueName = (typeof ORGANIZATION_QUEUE_NAMES)[number];

export { ORGANIZATION_QUEUE_NAMES };

export function organizationWorkflowQueueName(name: OrganizationQueueName): OrganizationQueueName {
  return name;
}

const ORGANIZATION_PROFILE_ROW_ID = "profile";

function assertOrganization(c: { state: OrganizationState }, organizationId: string): void {
  if (organizationId !== c.state.organizationId) {
    throw new Error(`Organization actor mismatch: actor=${c.state.organizationId} command=${organizationId}`);
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

function parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function collectAllTaskSummaries(c: any): Promise<TaskSummary[]> {
  const repoRows = await c.db.select({ repoId: repos.repoId, remoteUrl: repos.remoteUrl }).from(repos).orderBy(desc(repos.updatedAt)).all();

  const all: TaskSummary[] = [];
  for (const row of repoRows) {
    try {
      const repository = await getOrCreateRepository(c, c.state.organizationId, row.repoId, row.remoteUrl);
      const snapshot = await repository.listTaskSummaries({ includeArchived: true });
      all.push(...snapshot);
    } catch (error) {
      logActorWarning("organization", "failed collecting tasks for repo", {
        organizationId: c.state.organizationId,
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

function buildRepoSummary(repoRow: { repoId: string; remoteUrl: string; updatedAt: number }, taskRows: WorkbenchTaskSummary[]): WorkbenchRepositorySummary {
  const repoTasks = taskRows.filter((task) => task.repoId === repoRow.repoId);
  const latestActivityMs = repoTasks.reduce((latest, task) => Math.max(latest, task.updatedAtMs), repoRow.updatedAt);

  return {
    id: repoRow.repoId,
    label: repoLabelFromRemote(repoRow.remoteUrl),
    taskCount: repoTasks.length,
    latestActivityMs,
  };
}

function taskSummaryRowFromSummary(taskSummary: WorkbenchTaskSummary) {
  return {
    taskId: taskSummary.id,
    repoId: taskSummary.repoId,
    title: taskSummary.title,
    status: taskSummary.status,
    repoName: taskSummary.repoName,
    updatedAtMs: taskSummary.updatedAtMs,
    branch: taskSummary.branch,
    pullRequestJson: JSON.stringify(taskSummary.pullRequest),
    sessionsSummaryJson: JSON.stringify(taskSummary.sessionsSummary),
  };
}

function taskSummaryFromRow(row: any): WorkbenchTaskSummary {
  return {
    id: row.taskId,
    repoId: row.repoId,
    title: row.title,
    status: row.status,
    repoName: row.repoName,
    updatedAtMs: row.updatedAtMs,
    branch: row.branch ?? null,
    pullRequest: parseJsonValue(row.pullRequestJson, null),
    sessionsSummary: parseJsonValue<WorkbenchSessionSummary[]>(row.sessionsSummaryJson, []),
  };
}

async function listOpenPullRequestsSnapshot(c: any, taskRows: WorkbenchTaskSummary[]): Promise<WorkbenchOpenPrSummary[]> {
  const githubData = getGithubData(c, c.state.organizationId);
  const openPullRequests = await githubData.listOpenPullRequests({}).catch(() => []);
  const claimedBranches = new Set(taskRows.filter((task) => task.branch).map((task) => `${task.repoId}:${task.branch}`));

  return openPullRequests.filter((pullRequest: WorkbenchOpenPrSummary) => !claimedBranches.has(`${pullRequest.repoId}:${pullRequest.headRefName}`));
}

async function reconcileWorkbenchProjection(c: any): Promise<OrganizationSummarySnapshot> {
  const repoRows = await c.db
    .select({ repoId: repos.repoId, remoteUrl: repos.remoteUrl, updatedAt: repos.updatedAt })
    .from(repos)
    .orderBy(desc(repos.updatedAt))
    .all();

  const taskRows: WorkbenchTaskSummary[] = [];
  for (const row of repoRows) {
    try {
      const repository = await getOrCreateRepository(c, c.state.organizationId, row.repoId, row.remoteUrl);
      const summaries = await repository.listTaskSummaries({ includeArchived: true });
      for (const summary of summaries) {
        try {
          await upsertTaskLookupRow(c, summary.taskId, row.repoId);
          const task = getTask(c, c.state.organizationId, row.repoId, summary.taskId);
          const taskSummary = await task.getTaskSummary({});
          taskRows.push(taskSummary);
          await c.db
            .insert(taskSummaries)
            .values(taskSummaryRowFromSummary(taskSummary))
            .onConflictDoUpdate({
              target: taskSummaries.taskId,
              set: taskSummaryRowFromSummary(taskSummary),
            })
            .run();
        } catch (error) {
          logActorWarning("organization", "failed collecting task summary during reconciliation", {
            organizationId: c.state.organizationId,
            repoId: row.repoId,
            taskId: summary.taskId,
            error: resolveErrorMessage(error),
          });
        }
      }
    } catch (error) {
      logActorWarning("organization", "failed collecting repo during workbench reconciliation", {
        organizationId: c.state.organizationId,
        repoId: row.repoId,
        error: resolveErrorMessage(error),
      });
    }
  }

  taskRows.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return {
    organizationId: c.state.organizationId,
    repos: repoRows.map((row) => buildRepoSummary(row, taskRows)).sort((left, right) => right.latestActivityMs - left.latestActivityMs),
    taskSummaries: taskRows,
    openPullRequests: await listOpenPullRequestsSnapshot(c, taskRows),
  };
}

async function requireWorkbenchTask(c: any, taskId: string) {
  const repoId = await resolveRepoId(c, taskId);
  return getTask(c, c.state.organizationId, repoId, taskId);
}

/**
 * Reads the organization sidebar snapshot from the organization actor's local SQLite
 * plus the org-scoped GitHub actor for open PRs. Task actors still push
 * summary updates into `task_summaries`, so the hot read path stays bounded.
 */
async function getOrganizationSummarySnapshot(c: any): Promise<OrganizationSummarySnapshot> {
  const repoRows = await c.db
    .select({
      repoId: repos.repoId,
      remoteUrl: repos.remoteUrl,
      updatedAt: repos.updatedAt,
    })
    .from(repos)
    .orderBy(desc(repos.updatedAt))
    .all();
  const taskRows = await c.db.select().from(taskSummaries).orderBy(desc(taskSummaries.updatedAtMs)).all();
  const summaries = taskRows.map(taskSummaryFromRow);

  return {
    organizationId: c.state.organizationId,
    repos: repoRows.map((row) => buildRepoSummary(row, summaries)).sort((left, right) => right.latestActivityMs - left.latestActivityMs),
    taskSummaries: summaries,
    openPullRequests: await listOpenPullRequestsSnapshot(c, summaries),
  };
}

async function broadcastRepoSummary(
  c: any,
  type: "repoAdded" | "repoUpdated",
  repoRow: { repoId: string; remoteUrl: string; updatedAt: number },
): Promise<void> {
  const matchingTaskRows = await c.db.select().from(taskSummaries).where(eq(taskSummaries.repoId, repoRow.repoId)).all();
  const repo = buildRepoSummary(repoRow, matchingTaskRows.map(taskSummaryFromRow));
  c.broadcast("organizationUpdated", { type, repo } satisfies OrganizationEvent);
}

async function createTaskMutation(c: any, input: CreateTaskInput): Promise<TaskRecord> {
  assertOrganization(c, input.organizationId);

  const { config } = getActorRuntimeContext();
  const sandboxProviderId = input.sandboxProviderId ?? defaultSandboxProviderId(config);

  const repoId = input.repoId;
  const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, repoId)).get();
  if (!repoRow) {
    throw new Error(`Unknown repo: ${repoId}`);
  }
  const remoteUrl = repoRow.remoteUrl;

  const repository = await getOrCreateRepository(c, c.state.organizationId, repoId, remoteUrl);

  const created = await repository.createTask({
    task: input.task,
    sandboxProviderId,
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

  try {
    const task = getTask(c, c.state.organizationId, repoId, created.taskId);
    await organizationActions.applyTaskSummaryUpdate(c, {
      taskSummary: await task.getTaskSummary({}),
    });
  } catch (error) {
    logActorWarning("organization", "failed seeding task summary after task creation", {
      organizationId: c.state.organizationId,
      repoId,
      taskId: created.taskId,
      error: resolveErrorMessage(error),
    });
  }

  return created;
}

export async function runOrganizationWorkflow(ctx: any): Promise<void> {
  await ctx.loop("organization-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-organization-command", {
      names: [...ORGANIZATION_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }

    try {
      if (msg.name === "organization.command.createTask") {
        const result = await loopCtx.step({
          name: "organization-create-task",
          timeout: 5 * 60_000,
          run: async () => createTaskMutation(loopCtx, msg.body as CreateTaskInput),
        });
        await msg.complete(result);
        return Loop.continue(undefined);
      }

      if (msg.name === "organization.command.syncGithubSession") {
        await loopCtx.step({
          name: "organization-sync-github-session",
          timeout: 60_000,
          run: async () => {
            const { syncGithubOrganizations } = await import("./app-shell.js");
            await syncGithubOrganizations(loopCtx, msg.body as { sessionId: string; accessToken: string });
          },
        });
        await msg.complete({ ok: true });
        return Loop.continue(undefined);
      }
    } catch (error) {
      const message = resolveErrorMessage(error);
      logActorWarning("organization", "organization workflow command failed", {
        queueName: msg.name,
        error: message,
      });
      await msg.complete({ error: message }).catch((completeError: unknown) => {
        logActorWarning("organization", "organization workflow failed completing error response", {
          queueName: msg.name,
          error: resolveErrorMessage(completeError),
        });
      });
    }

    return Loop.continue(undefined);
  });
}

export const organizationActions = {
  ...organizationAppActions,
  async useOrganization(c: any, input: OrganizationUseInput): Promise<{ organizationId: string }> {
    assertOrganization(c, input.organizationId);
    return { organizationId: c.state.organizationId };
  },

  async listRepos(c: any, input: OrganizationUseInput): Promise<RepoRecord[]> {
    assertOrganization(c, input.organizationId);

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
      organizationId: c.state.organizationId,
      repoId: row.repoId,
      remoteUrl: row.remoteUrl,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  },

  async createTask(c: any, input: CreateTaskInput): Promise<TaskRecord> {
    const self = selfOrganization(c);
    return expectQueueResponse<TaskRecord>(
      await self.send(organizationWorkflowQueueName("organization.command.createTask"), input, {
        wait: true,
        timeout: 10_000,
      }),
    );
  },

  async starSandboxAgentRepo(c: any, input: StarSandboxAgentRepoInput): Promise<StarSandboxAgentRepoResult> {
    assertOrganization(c, input.organizationId);
    const { driver } = getActorRuntimeContext();
    const auth = await resolveOrganizationGithubAuth(c, c.state.organizationId);
    await driver.github.starRepository(SANDBOX_AGENT_REPO, {
      githubToken: auth?.githubToken ?? null,
    });
    return {
      repo: SANDBOX_AGENT_REPO,
      starredAt: Date.now(),
    };
  },

  /**
   * Called by task actors when their summary-level state changes.
   * This is the write path for the local materialized projection; clients read
   * the projection via `getOrganizationSummary`, but only task actors should push
   * rows into it.
   */
  async applyTaskSummaryUpdate(c: any, input: { taskSummary: WorkbenchTaskSummary }): Promise<void> {
    await c.db
      .insert(taskSummaries)
      .values(taskSummaryRowFromSummary(input.taskSummary))
      .onConflictDoUpdate({
        target: taskSummaries.taskId,
        set: taskSummaryRowFromSummary(input.taskSummary),
      })
      .run();
    c.broadcast("organizationUpdated", { type: "taskSummaryUpdated", taskSummary: input.taskSummary } satisfies OrganizationEvent);
  },

  async removeTaskSummary(c: any, input: { taskId: string }): Promise<void> {
    await c.db.delete(taskSummaries).where(eq(taskSummaries.taskId, input.taskId)).run();
    c.broadcast("organizationUpdated", { type: "taskRemoved", taskId: input.taskId } satisfies OrganizationEvent);
  },

  async findTaskForGithubBranch(c: any, input: { repoId: string; branchName: string }): Promise<{ taskId: string | null }> {
    const summaries = await c.db.select().from(taskSummaries).where(eq(taskSummaries.repoId, input.repoId)).all();
    const existing = summaries.find((summary) => summary.branch === input.branchName);
    return { taskId: existing?.taskId ?? null };
  },

  async refreshTaskSummaryForGithubBranch(c: any, input: { repoId: string; branchName: string }): Promise<void> {
    const summaries = await c.db.select().from(taskSummaries).where(eq(taskSummaries.repoId, input.repoId)).all();
    const matches = summaries.filter((summary) => summary.branch === input.branchName);

    for (const summary of matches) {
      try {
        const task = getTask(c, c.state.organizationId, input.repoId, summary.taskId);
        await organizationActions.applyTaskSummaryUpdate(c, {
          taskSummary: await task.getTaskSummary({}),
        });
      } catch (error) {
        logActorWarning("organization", "failed refreshing task summary for GitHub branch", {
          organizationId: c.state.organizationId,
          repoId: input.repoId,
          branchName: input.branchName,
          taskId: summary.taskId,
          error: resolveErrorMessage(error),
        });
      }
    }
  },

  async applyOpenPullRequestUpdate(c: any, input: { pullRequest: WorkbenchOpenPrSummary }): Promise<void> {
    const summaries = await c.db.select().from(taskSummaries).where(eq(taskSummaries.repoId, input.pullRequest.repoId)).all();
    if (summaries.some((summary) => summary.branch === input.pullRequest.headRefName)) {
      return;
    }
    c.broadcast("organizationUpdated", { type: "pullRequestUpdated", pullRequest: input.pullRequest } satisfies OrganizationEvent);
  },

  async removeOpenPullRequest(c: any, input: { prId: string }): Promise<void> {
    c.broadcast("organizationUpdated", { type: "pullRequestRemoved", prId: input.prId } satisfies OrganizationEvent);
  },

  async applyGithubRepositoryProjection(c: any, input: { repoId: string; remoteUrl: string }): Promise<void> {
    const now = Date.now();
    const existing = await c.db.select({ repoId: repos.repoId }).from(repos).where(eq(repos.repoId, input.repoId)).get();
    await c.db
      .insert(repos)
      .values({
        repoId: input.repoId,
        remoteUrl: input.remoteUrl,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: repos.repoId,
        set: {
          remoteUrl: input.remoteUrl,
          updatedAt: now,
        },
      })
      .run();
    await broadcastRepoSummary(c, existing ? "repoUpdated" : "repoAdded", {
      repoId: input.repoId,
      remoteUrl: input.remoteUrl,
      updatedAt: now,
    });
  },

  async applyGithubDataProjection(
    c: any,
    input: {
      connectedAccount: string;
      installationStatus: string;
      installationId: number | null;
      syncStatus: string;
      lastSyncLabel: string;
      lastSyncAt: number | null;
      repositories: Array<{ fullName: string; cloneUrl: string; private: boolean }>;
    },
  ): Promise<void> {
    const existingRepos = await c.db.select({ repoId: repos.repoId, remoteUrl: repos.remoteUrl, updatedAt: repos.updatedAt }).from(repos).all();
    const existingById = new Map(existingRepos.map((repo) => [repo.repoId, repo]));
    const nextRepoIds = new Set<string>();
    const now = Date.now();

    for (const repository of input.repositories) {
      const repoId = repoIdFromRemote(repository.cloneUrl);
      nextRepoIds.add(repoId);
      await c.db
        .insert(repos)
        .values({
          repoId,
          remoteUrl: repository.cloneUrl,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: repos.repoId,
          set: {
            remoteUrl: repository.cloneUrl,
            updatedAt: now,
          },
        })
        .run();
      await broadcastRepoSummary(c, existingById.has(repoId) ? "repoUpdated" : "repoAdded", {
        repoId,
        remoteUrl: repository.cloneUrl,
        updatedAt: now,
      });
    }

    for (const repo of existingRepos) {
      if (nextRepoIds.has(repo.repoId)) {
        continue;
      }
      await c.db.delete(repos).where(eq(repos.repoId, repo.repoId)).run();
      c.broadcast("organizationUpdated", { type: "repoRemoved", repoId: repo.repoId } satisfies OrganizationEvent);
    }

    const profile = await c.db
      .select({ id: organizationProfile.id })
      .from(organizationProfile)
      .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
      .get();
    if (profile) {
      await c.db
        .update(organizationProfile)
        .set({
          githubConnectedAccount: input.connectedAccount,
          githubInstallationStatus: input.installationStatus,
          githubSyncStatus: input.syncStatus,
          githubInstallationId: input.installationId,
          githubLastSyncLabel: input.lastSyncLabel,
          githubLastSyncAt: input.lastSyncAt,
          updatedAt: now,
        })
        .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
        .run();
    }
  },

  async recordGithubWebhookReceipt(
    c: any,
    input: {
      organizationId: string;
      event: string;
      action?: string | null;
      receivedAt?: number;
    },
  ): Promise<void> {
    assertOrganization(c, input.organizationId);

    const profile = await c.db
      .select({ id: organizationProfile.id })
      .from(organizationProfile)
      .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
      .get();
    if (!profile) {
      return;
    }

    await c.db
      .update(organizationProfile)
      .set({
        githubLastWebhookAt: input.receivedAt ?? Date.now(),
        githubLastWebhookEvent: input.action ? `${input.event}.${input.action}` : input.event,
      })
      .where(eq(organizationProfile.id, ORGANIZATION_PROFILE_ROW_ID))
      .run();
  },

  async getOrganizationSummary(c: any, input: OrganizationUseInput): Promise<OrganizationSummarySnapshot> {
    assertOrganization(c, input.organizationId);
    return await getOrganizationSummarySnapshot(c);
  },

  async reconcileWorkbenchState(c: any, input: OrganizationUseInput): Promise<OrganizationSummarySnapshot> {
    assertOrganization(c, input.organizationId);
    return await reconcileWorkbenchProjection(c);
  },

  async createWorkbenchTask(c: any, input: TaskWorkbenchCreateTaskInput): Promise<{ taskId: string; sessionId?: string }> {
    // Step 1: Create the task record (wait: true — local state mutations only).
    const created = await organizationActions.createTask(c, {
      organizationId: c.state.organizationId,
      repoId: input.repoId,
      task: input.task,
      ...(input.title ? { explicitTitle: input.title } : {}),
      ...(input.onBranch ? { onBranch: input.onBranch } : input.branch ? { explicitBranchName: input.branch } : {}),
      ...(input.model ? { agentType: agentTypeForModel(input.model) } : {}),
    });

    // Step 2: Enqueue session creation + initial message (wait: false).
    // The task workflow creates the session record and sends the message in
    // the background. The client observes progress via push events on the
    // task subscription topic.
    const task = await requireWorkbenchTask(c, created.taskId);
    await task.createWorkbenchSessionAndSend({
      model: input.model,
      text: input.task,
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

  async createWorkbenchSession(c: any, input: TaskWorkbenchSelectInput & { model?: string }): Promise<{ sessionId: string }> {
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

  async stopWorkbenchSession(c: any, input: TaskWorkbenchSessionInput): Promise<void> {
    const task = await requireWorkbenchTask(c, input.taskId);
    await task.stopWorkbenchSession(input);
  },

  async closeWorkbenchSession(c: any, input: TaskWorkbenchSessionInput): Promise<void> {
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

  async reloadGithubOrganization(c: any): Promise<void> {
    await getOrCreateGithubData(c, c.state.organizationId).reloadOrganization({});
  },

  async reloadGithubPullRequests(c: any): Promise<void> {
    await getOrCreateGithubData(c, c.state.organizationId).reloadAllPullRequests({});
  },

  async reloadGithubRepository(c: any, input: { repoId: string }): Promise<void> {
    await getOrCreateGithubData(c, c.state.organizationId).reloadRepository(input);
  },

  async reloadGithubPullRequest(c: any, input: { repoId: string; prNumber: number }): Promise<void> {
    await getOrCreateGithubData(c, c.state.organizationId).reloadPullRequest(input);
  },

  async listTasks(c: any, input: ListTasksInput): Promise<TaskSummary[]> {
    assertOrganization(c, input.organizationId);

    if (input.repoId) {
      const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, input.repoId)).get();
      if (!repoRow) {
        throw new Error(`Unknown repo: ${input.repoId}`);
      }

      const repository = await getOrCreateRepository(c, c.state.organizationId, input.repoId, repoRow.remoteUrl);
      return await repository.listTaskSummaries({ includeArchived: true });
    }

    return await collectAllTaskSummaries(c);
  },

  async getRepoOverview(c: any, input: RepoOverviewInput): Promise<RepoOverview> {
    assertOrganization(c, input.organizationId);

    const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, input.repoId)).get();
    if (!repoRow) {
      throw new Error(`Unknown repo: ${input.repoId}`);
    }

    const repository = await getOrCreateRepository(c, c.state.organizationId, input.repoId, repoRow.remoteUrl);
    return await repository.getRepoOverview({});
  },

  async switchTask(c: any, taskId: string): Promise<SwitchResult> {
    const repoId = await resolveRepoId(c, taskId);
    const h = getTask(c, c.state.organizationId, repoId, taskId);
    const record = await h.get();
    const switched = await h.switch();

    return {
      organizationId: c.state.organizationId,
      taskId,
      sandboxProviderId: record.sandboxProviderId,
      switchTarget: switched.switchTarget,
    };
  },

  async history(c: any, input: HistoryQueryInput): Promise<HistoryEvent[]> {
    assertOrganization(c, input.organizationId);

    const limit = input.limit ?? 20;
    const repoRows = await c.db.select({ repoId: repos.repoId }).from(repos).all();

    const allEvents: HistoryEvent[] = [];

    for (const row of repoRows) {
      try {
        const hist = await getOrCreateHistory(c, c.state.organizationId, row.repoId);
        const items = await hist.list({
          branch: input.branch,
          taskId: input.taskId,
          limit,
        });
        allEvents.push(...items);
      } catch (error) {
        logActorWarning("organization", "history lookup failed for repo", {
          organizationId: c.state.organizationId,
          repoId: row.repoId,
          error: resolveErrorMessage(error),
        });
      }
    }

    allEvents.sort((a, b) => b.createdAt - a.createdAt);
    return allEvents.slice(0, limit);
  },

  async getTask(c: any, input: GetTaskInput): Promise<TaskRecord> {
    assertOrganization(c, input.organizationId);

    const repoId = await resolveRepoId(c, input.taskId);

    const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, repoId)).get();
    if (!repoRow) {
      throw new Error(`Unknown repo: ${repoId}`);
    }

    const repository = await getOrCreateRepository(c, c.state.organizationId, repoId, repoRow.remoteUrl);
    return await repository.getTaskEnriched({ taskId: input.taskId });
  },

  async attachTask(c: any, input: TaskProxyActionInput): Promise<{ target: string; sessionId: string | null }> {
    assertOrganization(c, input.organizationId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.organizationId, repoId, input.taskId);
    return await h.attach({ reason: input.reason });
  },

  async pushTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.organizationId, repoId, input.taskId);
    await h.push({ reason: input.reason });
  },

  async syncTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.organizationId, repoId, input.taskId);
    await h.sync({ reason: input.reason });
  },

  async mergeTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.organizationId, repoId, input.taskId);
    await h.merge({ reason: input.reason });
  },

  async archiveTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.organizationId, repoId, input.taskId);
    await h.archive({ reason: input.reason });
  },

  async killTask(c: any, input: TaskProxyActionInput): Promise<void> {
    assertOrganization(c, input.organizationId);
    const repoId = await resolveRepoId(c, input.taskId);
    const h = getTask(c, c.state.organizationId, repoId, input.taskId);
    await h.kill({ reason: input.reason });
  },
};
