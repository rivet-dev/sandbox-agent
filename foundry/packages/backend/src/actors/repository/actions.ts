// @ts-nocheck
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { Loop } from "rivetkit/workflow";
import type { AgentType, RepoOverview, SandboxProviderId, TaskRecord, TaskSummary } from "@sandbox-agent/foundry-shared";
import { getGithubData, getOrCreateHistory, getOrCreateTask, getTask, selfRepository } from "../handles.js";
import { deriveFallbackTitle, resolveCreateFlowDecision } from "../../services/create-flow.js";
import { expectQueueResponse } from "../../services/queue.js";
import { isActorNotFoundError, logActorWarning, resolveErrorMessage } from "../logging.js";
import { repoMeta, taskIndex } from "./db/schema.js";

interface CreateTaskCommand {
  task: string;
  sandboxProviderId: SandboxProviderId;
  agentType: AgentType | null;
  explicitTitle: string | null;
  explicitBranchName: string | null;
  initialPrompt: string | null;
  onBranch: string | null;
}

interface RegisterTaskBranchCommand {
  taskId: string;
  branchName: string;
  requireExistingRemote?: boolean;
}

interface ListTaskSummariesCommand {
  includeArchived?: boolean;
}

interface GetTaskEnrichedCommand {
  taskId: string;
}

interface GetPullRequestForBranchCommand {
  branchName: string;
}

const REPOSITORY_QUEUE_NAMES = ["repository.command.createTask", "repository.command.registerTaskBranch"] as const;

type RepositoryQueueName = (typeof REPOSITORY_QUEUE_NAMES)[number];

export { REPOSITORY_QUEUE_NAMES };

export function repositoryWorkflowQueueName(name: RepositoryQueueName): RepositoryQueueName {
  return name;
}

function isStaleTaskReferenceError(error: unknown): boolean {
  const message = resolveErrorMessage(error);
  return isActorNotFoundError(error) || message.startsWith("Task not found:");
}

async function persistRemoteUrl(c: any, remoteUrl: string): Promise<void> {
  c.state.remoteUrl = remoteUrl;
  await c.db
    .insert(repoMeta)
    .values({
      id: 1,
      remoteUrl,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: repoMeta.id,
      set: {
        remoteUrl,
        updatedAt: Date.now(),
      },
    })
    .run();
}

async function deleteStaleTaskIndexRow(c: any, taskId: string): Promise<void> {
  try {
    await c.db.delete(taskIndex).where(eq(taskIndex.taskId, taskId)).run();
  } catch {
    // Best effort cleanup only.
  }
}

async function reinsertTaskIndexRow(c: any, taskId: string, branchName: string | null, updatedAt: number): Promise<void> {
  const now = Date.now();
  await c.db
    .insert(taskIndex)
    .values({
      taskId,
      branchName,
      createdAt: updatedAt || now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskIndex.taskId,
      set: {
        branchName,
        updatedAt: now,
      },
    })
    .run();
}

async function listKnownTaskBranches(c: any): Promise<string[]> {
  const rows = await c.db.select({ branchName: taskIndex.branchName }).from(taskIndex).where(isNotNull(taskIndex.branchName)).all();
  return rows.map((row) => row.branchName).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

async function resolveGitHubRepository(c: any) {
  const githubData = getGithubData(c, c.state.organizationId);
  return await githubData.getRepository({ repoId: c.state.repoId }).catch(() => null);
}

async function listGitHubBranches(c: any): Promise<Array<{ branchName: string; commitSha: string }>> {
  const githubData = getGithubData(c, c.state.organizationId);
  return await githubData.listBranchesForRepository({ repoId: c.state.repoId }).catch(() => []);
}

async function enrichTaskRecord(c: any, record: TaskRecord): Promise<TaskRecord> {
  const branchName = record.branchName?.trim() || null;
  if (!branchName) {
    return record;
  }

  const pr =
    branchName != null
      ? await getGithubData(c, c.state.organizationId)
          .listPullRequestsForRepository({ repoId: c.state.repoId })
          .then((rows: any[]) => rows.find((row) => row.headRefName === branchName) ?? null)
          .catch(() => null)
      : null;

  return {
    ...record,
    prUrl: pr?.url ?? null,
    prAuthor: pr?.authorLogin ?? null,
    ciStatus: null,
    reviewStatus: null,
    reviewer: pr?.authorLogin ?? null,
    diffStat: record.diffStat ?? null,
    hasUnpushed: record.hasUnpushed ?? null,
    conflictsWithMain: record.conflictsWithMain ?? null,
    parentBranch: record.parentBranch ?? null,
  };
}

async function createTaskMutation(c: any, cmd: CreateTaskCommand): Promise<TaskRecord> {
  const organizationId = c.state.organizationId;
  const repoId = c.state.repoId;
  const repoRemote = c.state.remoteUrl;
  const onBranch = cmd.onBranch?.trim() || null;
  const taskId = randomUUID();
  let initialBranchName: string | null = null;
  let initialTitle: string | null = null;

  await persistRemoteUrl(c, repoRemote);

  if (onBranch) {
    initialBranchName = onBranch;
    initialTitle = deriveFallbackTitle(cmd.task, cmd.explicitTitle ?? undefined);

    await registerTaskBranchMutation(c, {
      taskId,
      branchName: onBranch,
      requireExistingRemote: true,
    });
  } else {
    const reservedBranches = await listKnownTaskBranches(c);
    const resolved = resolveCreateFlowDecision({
      task: cmd.task,
      explicitTitle: cmd.explicitTitle ?? undefined,
      explicitBranchName: cmd.explicitBranchName ?? undefined,
      localBranches: [],
      taskBranches: reservedBranches,
    });

    initialBranchName = resolved.branchName;
    initialTitle = resolved.title;

    const now = Date.now();
    await c.db
      .insert(taskIndex)
      .values({
        taskId,
        branchName: resolved.branchName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }

  let taskHandle: Awaited<ReturnType<typeof getOrCreateTask>>;
  try {
    taskHandle = await getOrCreateTask(c, organizationId, repoId, taskId, {
      organizationId,
      repoId,
      taskId,
      repoRemote,
      branchName: initialBranchName,
      title: initialTitle,
      task: cmd.task,
      sandboxProviderId: cmd.sandboxProviderId,
      agentType: cmd.agentType,
      explicitTitle: null,
      explicitBranchName: null,
      initialPrompt: cmd.initialPrompt,
    });
  } catch (error) {
    if (initialBranchName) {
      await deleteStaleTaskIndexRow(c, taskId);
    }
    throw error;
  }

  const created = await taskHandle.initialize({ sandboxProviderId: cmd.sandboxProviderId });

  const history = await getOrCreateHistory(c, organizationId, repoId);
  await history.append({
    kind: "task.created",
    taskId,
    payload: {
      repoId,
      sandboxProviderId: cmd.sandboxProviderId,
    },
  });

  return created;
}

async function registerTaskBranchMutation(c: any, cmd: RegisterTaskBranchCommand): Promise<{ branchName: string; headSha: string }> {
  const branchName = cmd.branchName.trim();
  if (!branchName) {
    throw new Error("branchName is required");
  }

  await persistRemoteUrl(c, c.state.remoteUrl);

  const existingOwner = await c.db
    .select({ taskId: taskIndex.taskId })
    .from(taskIndex)
    .where(and(eq(taskIndex.branchName, branchName), ne(taskIndex.taskId, cmd.taskId)))
    .get();

  if (existingOwner) {
    let ownerMissing = false;
    try {
      await getTask(c, c.state.organizationId, c.state.repoId, existingOwner.taskId).get();
    } catch (error) {
      if (isStaleTaskReferenceError(error)) {
        ownerMissing = true;
        await deleteStaleTaskIndexRow(c, existingOwner.taskId);
      } else {
        throw error;
      }
    }
    if (!ownerMissing) {
      throw new Error(`branch is already assigned to a different task: ${branchName}`);
    }
  }

  const branches = await listGitHubBranches(c);
  const branchMatch = branches.find((branch) => branch.branchName === branchName) ?? null;
  if (cmd.requireExistingRemote && !branchMatch) {
    throw new Error(`Remote branch not found: ${branchName}`);
  }

  const repository = await resolveGitHubRepository(c);
  const defaultBranch = repository?.defaultBranch ?? "main";
  const headSha = branchMatch?.commitSha ?? branches.find((branch) => branch.branchName === defaultBranch)?.commitSha ?? "";

  const now = Date.now();
  await c.db
    .insert(taskIndex)
    .values({
      taskId: cmd.taskId,
      branchName,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskIndex.taskId,
      set: {
        branchName,
        updatedAt: now,
      },
    })
    .run();

  return { branchName, headSha };
}

async function listTaskSummaries(c: any, includeArchived = false): Promise<TaskSummary[]> {
  const taskRows = await c.db.select({ taskId: taskIndex.taskId }).from(taskIndex).orderBy(desc(taskIndex.updatedAt)).all();
  const records: TaskSummary[] = [];

  for (const row of taskRows) {
    try {
      const record = await getTask(c, c.state.organizationId, c.state.repoId, row.taskId).get();
      if (!includeArchived && record.status === "archived") {
        continue;
      }
      records.push({
        organizationId: record.organizationId,
        repoId: record.repoId,
        taskId: record.taskId,
        branchName: record.branchName,
        title: record.title,
        status: record.status,
        updatedAt: record.updatedAt,
      });
    } catch (error) {
      if (isStaleTaskReferenceError(error)) {
        await deleteStaleTaskIndexRow(c, row.taskId);
        continue;
      }
      logActorWarning("repository", "failed loading task summary row", {
        organizationId: c.state.organizationId,
        repoId: c.state.repoId,
        taskId: row.taskId,
        error: resolveErrorMessage(error),
      });
    }
  }

  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return records;
}

function sortOverviewBranches(
  branches: Array<{
    branchName: string;
    commitSha: string;
    taskId: string | null;
    taskTitle: string | null;
    taskStatus: TaskRecord["status"] | null;
    prNumber: number | null;
    prState: string | null;
    prUrl: string | null;
    ciStatus: string | null;
    reviewStatus: string | null;
    reviewer: string | null;
    updatedAt: number;
  }>,
  defaultBranch: string | null,
) {
  return [...branches].sort((left, right) => {
    if (defaultBranch) {
      if (left.branchName === defaultBranch && right.branchName !== defaultBranch) return -1;
      if (right.branchName === defaultBranch && left.branchName !== defaultBranch) return 1;
    }
    if (Boolean(left.taskId) !== Boolean(right.taskId)) {
      return left.taskId ? -1 : 1;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.branchName.localeCompare(right.branchName);
  });
}

export async function runRepositoryWorkflow(ctx: any): Promise<void> {
  await ctx.loop("repository-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-repository-command", {
      names: [...REPOSITORY_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }

    try {
      if (msg.name === "repository.command.createTask") {
        const result = await loopCtx.step({
          name: "repository-create-task",
          timeout: 5 * 60_000,
          run: async () => createTaskMutation(loopCtx, msg.body as CreateTaskCommand),
        });
        await msg.complete(result);
        return Loop.continue(undefined);
      }

      if (msg.name === "repository.command.registerTaskBranch") {
        const result = await loopCtx.step({
          name: "repository-register-task-branch",
          timeout: 60_000,
          run: async () => registerTaskBranchMutation(loopCtx, msg.body as RegisterTaskBranchCommand),
        });
        await msg.complete(result);
        return Loop.continue(undefined);
      }
    } catch (error) {
      const message = resolveErrorMessage(error);
      logActorWarning("repository", "repository workflow command failed", {
        queueName: msg.name,
        error: message,
      });
      await msg.complete({ error: message }).catch(() => {});
    }

    return Loop.continue(undefined);
  });
}

export const repositoryActions = {
  async createTask(c: any, cmd: CreateTaskCommand): Promise<TaskRecord> {
    const self = selfRepository(c);
    return expectQueueResponse<TaskRecord>(
      await self.send(repositoryWorkflowQueueName("repository.command.createTask"), cmd, {
        wait: true,
        timeout: 10_000,
      }),
    );
  },

  async listReservedBranches(c: any): Promise<string[]> {
    return await listKnownTaskBranches(c);
  },

  async registerTaskBranch(c: any, cmd: RegisterTaskBranchCommand): Promise<{ branchName: string; headSha: string }> {
    const self = selfRepository(c);
    return expectQueueResponse<{ branchName: string; headSha: string }>(
      await self.send(repositoryWorkflowQueueName("repository.command.registerTaskBranch"), cmd, {
        wait: true,
        timeout: 10_000,
      }),
    );
  },

  async listTaskSummaries(c: any, cmd?: ListTaskSummariesCommand): Promise<TaskSummary[]> {
    return await listTaskSummaries(c, cmd?.includeArchived === true);
  },

  async getTaskEnriched(c: any, cmd: GetTaskEnrichedCommand): Promise<TaskRecord> {
    const row = await c.db.select({ taskId: taskIndex.taskId }).from(taskIndex).where(eq(taskIndex.taskId, cmd.taskId)).get();
    if (!row) {
      const record = await getTask(c, c.state.organizationId, c.state.repoId, cmd.taskId).get();
      await reinsertTaskIndexRow(c, cmd.taskId, record.branchName ?? null, record.updatedAt ?? Date.now());
      return await enrichTaskRecord(c, record);
    }

    try {
      const record = await getTask(c, c.state.organizationId, c.state.repoId, cmd.taskId).get();
      return await enrichTaskRecord(c, record);
    } catch (error) {
      if (isStaleTaskReferenceError(error)) {
        await deleteStaleTaskIndexRow(c, cmd.taskId);
        throw new Error(`Unknown task in repo ${c.state.repoId}: ${cmd.taskId}`);
      }
      throw error;
    }
  },

  async getRepositoryMetadata(c: any): Promise<{ defaultBranch: string | null; fullName: string | null; remoteUrl: string }> {
    const repository = await resolveGitHubRepository(c);
    return {
      defaultBranch: repository?.defaultBranch ?? null,
      fullName: repository?.fullName ?? null,
      remoteUrl: c.state.remoteUrl,
    };
  },

  async getRepoOverview(c: any): Promise<RepoOverview> {
    await persistRemoteUrl(c, c.state.remoteUrl);

    const now = Date.now();
    const repository = await resolveGitHubRepository(c);
    const githubBranches = await listGitHubBranches(c).catch(() => []);
    const githubData = getGithubData(c, c.state.organizationId);
    const prRows = await githubData.listPullRequestsForRepository({ repoId: c.state.repoId }).catch(() => []);
    const prByBranch = new Map(prRows.map((row) => [row.headRefName, row]));

    const taskRows = await c.db
      .select({
        taskId: taskIndex.taskId,
        branchName: taskIndex.branchName,
        updatedAt: taskIndex.updatedAt,
      })
      .from(taskIndex)
      .all();

    const taskMetaByBranch = new Map<string, { taskId: string; title: string | null; status: TaskRecord["status"] | null; updatedAt: number }>();
    for (const row of taskRows) {
      if (!row.branchName) {
        continue;
      }
      try {
        const record = await getTask(c, c.state.organizationId, c.state.repoId, row.taskId).get();
        taskMetaByBranch.set(row.branchName, {
          taskId: row.taskId,
          title: record.title ?? null,
          status: record.status,
          updatedAt: record.updatedAt,
        });
      } catch (error) {
        if (isStaleTaskReferenceError(error)) {
          await deleteStaleTaskIndexRow(c, row.taskId);
          continue;
        }
      }
    }

    const branchMap = new Map<string, { branchName: string; commitSha: string }>();
    for (const branch of githubBranches) {
      branchMap.set(branch.branchName, branch);
    }
    for (const branchName of taskMetaByBranch.keys()) {
      if (!branchMap.has(branchName)) {
        branchMap.set(branchName, { branchName, commitSha: "" });
      }
    }
    if (repository?.defaultBranch && !branchMap.has(repository.defaultBranch)) {
      branchMap.set(repository.defaultBranch, { branchName: repository.defaultBranch, commitSha: "" });
    }

    const branches = sortOverviewBranches(
      [...branchMap.values()].map((branch) => {
        const taskMeta = taskMetaByBranch.get(branch.branchName);
        const pr = prByBranch.get(branch.branchName);
        return {
          branchName: branch.branchName,
          commitSha: branch.commitSha,
          taskId: taskMeta?.taskId ?? null,
          taskTitle: taskMeta?.title ?? null,
          taskStatus: taskMeta?.status ?? null,
          prNumber: pr?.number ?? null,
          prState: pr?.state ?? null,
          prUrl: pr?.url ?? null,
          ciStatus: null,
          reviewStatus: null,
          reviewer: pr?.authorLogin ?? null,
          updatedAt: Math.max(taskMeta?.updatedAt ?? 0, pr?.updatedAtMs ?? 0, now),
        };
      }),
      repository?.defaultBranch ?? null,
    );

    return {
      organizationId: c.state.organizationId,
      repoId: c.state.repoId,
      remoteUrl: c.state.remoteUrl,
      baseRef: repository?.defaultBranch ?? null,
      fetchedAt: now,
      branches,
    };
  },

  async getPullRequestForBranch(c: any, cmd: GetPullRequestForBranchCommand): Promise<{ number: number; status: "draft" | "ready" } | null> {
    const branchName = cmd.branchName?.trim();
    if (!branchName) {
      return null;
    }
    const githubData = getGithubData(c, c.state.organizationId);
    return await githubData.getPullRequestForBranch({
      repoId: c.state.repoId,
      branchName,
    });
  },
};
