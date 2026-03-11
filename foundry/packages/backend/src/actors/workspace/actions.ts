// @ts-nocheck
import { desc, eq } from "drizzle-orm";
import { Loop } from "rivetkit/workflow";
import type {
  AddRepoInput,
  CreateHandoffInput,
  HandoffRecord,
  HandoffSummary,
  HandoffWorkbenchChangeModelInput,
  HandoffWorkbenchCreateHandoffInput,
  HandoffWorkbenchDiffInput,
  HandoffWorkbenchRenameInput,
  HandoffWorkbenchRenameSessionInput,
  HandoffWorkbenchSelectInput,
  HandoffWorkbenchSetSessionUnreadInput,
  HandoffWorkbenchSendMessageInput,
  HandoffWorkbenchSnapshot,
  HandoffWorkbenchTabInput,
  HandoffWorkbenchUpdateDraftInput,
  HistoryEvent,
  HistoryQueryInput,
  ListHandoffsInput,
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
import { getHandoff, getOrCreateHistory, getOrCreateProject, selfWorkspace } from "../handles.js";
import { logActorWarning, resolveErrorMessage } from "../logging.js";
import { normalizeRemoteUrl, repoIdFromRemote } from "../../services/repo.js";
import { handoffLookup, repos, providerProfiles } from "./db/schema.js";
import { agentTypeForModel } from "../handoff/workbench.js";
import { expectQueueResponse } from "../../services/queue.js";
import { workspaceAppActions } from "./app-shell.js";

interface WorkspaceState {
  workspaceId: string;
}

interface RefreshProviderProfilesCommand {
  providerId?: ProviderId;
}

interface GetHandoffInput {
  workspaceId: string;
  handoffId: string;
}

interface HandoffProxyActionInput extends GetHandoffInput {
  reason?: string;
}

interface RepoOverviewInput {
  workspaceId: string;
  repoId: string;
}

const WORKSPACE_QUEUE_NAMES = ["workspace.command.addRepo", "workspace.command.createHandoff", "workspace.command.refreshProviderProfiles"] as const;
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

async function resolveRepoId(c: any, handoffId: string): Promise<string> {
  const row = await c.db.select({ repoId: handoffLookup.repoId }).from(handoffLookup).where(eq(handoffLookup.handoffId, handoffId)).get();

  if (!row) {
    throw new Error(`Unknown handoff: ${handoffId} (not in lookup)`);
  }

  return row.repoId;
}

async function upsertHandoffLookupRow(c: any, handoffId: string, repoId: string): Promise<void> {
  await c.db
    .insert(handoffLookup)
    .values({
      handoffId,
      repoId,
    })
    .onConflictDoUpdate({
      target: handoffLookup.handoffId,
      set: { repoId },
    })
    .run();
}

async function collectAllHandoffSummaries(c: any): Promise<HandoffSummary[]> {
  const repoRows = await c.db.select({ repoId: repos.repoId, remoteUrl: repos.remoteUrl }).from(repos).orderBy(desc(repos.updatedAt)).all();

  const all: HandoffSummary[] = [];
  for (const row of repoRows) {
    try {
      const project = await getOrCreateProject(c, c.state.workspaceId, row.repoId, row.remoteUrl);
      const snapshot = await project.listHandoffSummaries({ includeArchived: true });
      all.push(...snapshot);
    } catch (error) {
      logActorWarning("workspace", "failed collecting handoffs for repo", {
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

async function buildWorkbenchSnapshot(c: any): Promise<HandoffWorkbenchSnapshot> {
  const repoRows = await c.db
    .select({ repoId: repos.repoId, remoteUrl: repos.remoteUrl, updatedAt: repos.updatedAt })
    .from(repos)
    .orderBy(desc(repos.updatedAt))
    .all();

  const handoffs: Array<any> = [];
  const projects: Array<any> = [];
  for (const row of repoRows) {
    const projectHandoffs: Array<any> = [];
    try {
      const project = await getOrCreateProject(c, c.state.workspaceId, row.repoId, row.remoteUrl);
      const summaries = await project.listHandoffSummaries({ includeArchived: true });
      for (const summary of summaries) {
        try {
          await upsertHandoffLookupRow(c, summary.handoffId, row.repoId);
          const handoff = getHandoff(c, c.state.workspaceId, row.repoId, summary.handoffId);
          const snapshot = await handoff.getWorkbench({});
          handoffs.push(snapshot);
          projectHandoffs.push(snapshot);
        } catch (error) {
          logActorWarning("workspace", "failed collecting workbench handoff", {
            workspaceId: c.state.workspaceId,
            repoId: row.repoId,
            handoffId: summary.handoffId,
            error: resolveErrorMessage(error),
          });
        }
      }

      if (projectHandoffs.length > 0) {
        projects.push({
          id: row.repoId,
          label: repoLabelFromRemote(row.remoteUrl),
          updatedAtMs: projectHandoffs[0]?.updatedAtMs ?? row.updatedAt,
          handoffs: projectHandoffs.sort((left, right) => right.updatedAtMs - left.updatedAtMs),
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

  handoffs.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  projects.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  return {
    workspaceId: c.state.workspaceId,
    repos: repoRows.map((row) => ({
      id: row.repoId,
      label: repoLabelFromRemote(row.remoteUrl),
    })),
    projects,
    handoffs,
  };
}

async function requireWorkbenchHandoff(c: any, handoffId: string) {
  const repoId = await resolveRepoId(c, handoffId);
  return getHandoff(c, c.state.workspaceId, repoId, handoffId);
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

async function createHandoffMutation(c: any, input: CreateHandoffInput): Promise<HandoffRecord> {
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

  const created = await project.createHandoff({
    task: input.task,
    providerId,
    agentType: input.agentType ?? null,
    explicitTitle: input.explicitTitle ?? null,
    explicitBranchName: input.explicitBranchName ?? null,
    onBranch: input.onBranch ?? null,
  });

  await c.db
    .insert(handoffLookup)
    .values({
      handoffId: created.handoffId,
      repoId,
    })
    .onConflictDoUpdate({
      target: handoffLookup.handoffId,
      set: { repoId },
    })
    .run();

  const handoff = getHandoff(c, c.state.workspaceId, repoId, created.handoffId);
  await handoff.provision({ providerId });

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

    if (msg.name === "workspace.command.createHandoff") {
      const result = await loopCtx.step({
        name: "workspace-create-handoff",
        timeout: 12 * 60_000,
        run: async () => createHandoffMutation(loopCtx, msg.body as CreateHandoffInput),
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

  async createHandoff(c: any, input: CreateHandoffInput): Promise<HandoffRecord> {
    const self = selfWorkspace(c);
    return expectQueueResponse<HandoffRecord>(
      await self.send(workspaceWorkflowQueueName("workspace.command.createHandoff"), input, {
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

  async getWorkbench(c: any, input: WorkspaceUseInput): Promise<HandoffWorkbenchSnapshot> {
    assertWorkspace(c, input.workspaceId);
    return await buildWorkbenchSnapshot(c);
  },

  async notifyWorkbenchUpdated(c: any): Promise<void> {
    c.broadcast("workbenchUpdated", { at: Date.now() });
  },

  async createWorkbenchHandoff(c: any, input: HandoffWorkbenchCreateHandoffInput): Promise<{ handoffId: string }> {
    const created = await workspaceActions.createHandoff(c, {
      workspaceId: c.state.workspaceId,
      repoId: input.repoId,
      task: input.task,
      ...(input.title ? { explicitTitle: input.title } : {}),
      ...(input.branch ? { explicitBranchName: input.branch } : {}),
      ...(input.model ? { agentType: agentTypeForModel(input.model) } : {}),
    });
    return { handoffId: created.handoffId };
  },

  async markWorkbenchUnread(c: any, input: HandoffWorkbenchSelectInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.markWorkbenchUnread({});
  },

  async renameWorkbenchHandoff(c: any, input: HandoffWorkbenchRenameInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.renameWorkbenchHandoff(input);
  },

  async renameWorkbenchBranch(c: any, input: HandoffWorkbenchRenameInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.renameWorkbenchBranch(input);
  },

  async createWorkbenchSession(c: any, input: HandoffWorkbenchSelectInput & { model?: string }): Promise<{ tabId: string }> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    return await handoff.createWorkbenchSession({ ...(input.model ? { model: input.model } : {}) });
  },

  async renameWorkbenchSession(c: any, input: HandoffWorkbenchRenameSessionInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.renameWorkbenchSession(input);
  },

  async setWorkbenchSessionUnread(c: any, input: HandoffWorkbenchSetSessionUnreadInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.setWorkbenchSessionUnread(input);
  },

  async updateWorkbenchDraft(c: any, input: HandoffWorkbenchUpdateDraftInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.updateWorkbenchDraft(input);
  },

  async changeWorkbenchModel(c: any, input: HandoffWorkbenchChangeModelInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.changeWorkbenchModel(input);
  },

  async sendWorkbenchMessage(c: any, input: HandoffWorkbenchSendMessageInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.sendWorkbenchMessage(input);
  },

  async stopWorkbenchSession(c: any, input: HandoffWorkbenchTabInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.stopWorkbenchSession(input);
  },

  async closeWorkbenchSession(c: any, input: HandoffWorkbenchTabInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.closeWorkbenchSession(input);
  },

  async publishWorkbenchPr(c: any, input: HandoffWorkbenchSelectInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.publishWorkbenchPr({});
  },

  async revertWorkbenchFile(c: any, input: HandoffWorkbenchDiffInput): Promise<void> {
    const handoff = await requireWorkbenchHandoff(c, input.handoffId);
    await handoff.revertWorkbenchFile(input);
  },

  async listHandoffs(c: any, input: ListHandoffsInput): Promise<HandoffSummary[]> {
    assertWorkspace(c, input.workspaceId);

    if (input.repoId) {
      const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, input.repoId)).get();
      if (!repoRow) {
        throw new Error(`Unknown repo: ${input.repoId}`);
      }

      const project = await getOrCreateProject(c, c.state.workspaceId, input.repoId, repoRow.remoteUrl);
      return await project.listHandoffSummaries({ includeArchived: true });
    }

    return await collectAllHandoffSummaries(c);
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

  async switchHandoff(c: any, handoffId: string): Promise<SwitchResult> {
    const repoId = await resolveRepoId(c, handoffId);
    const h = getHandoff(c, c.state.workspaceId, repoId, handoffId);
    const record = await h.get();
    const switched = await h.switch();

    return {
      workspaceId: c.state.workspaceId,
      handoffId,
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
          handoffId: input.handoffId,
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

  async getHandoff(c: any, input: GetHandoffInput): Promise<HandoffRecord> {
    assertWorkspace(c, input.workspaceId);

    const repoId = await resolveRepoId(c, input.handoffId);

    const repoRow = await c.db.select({ remoteUrl: repos.remoteUrl }).from(repos).where(eq(repos.repoId, repoId)).get();
    if (!repoRow) {
      throw new Error(`Unknown repo: ${repoId}`);
    }

    const project = await getOrCreateProject(c, c.state.workspaceId, repoId, repoRow.remoteUrl);
    return await project.getHandoffEnriched({ handoffId: input.handoffId });
  },

  async attachHandoff(c: any, input: HandoffProxyActionInput): Promise<{ target: string; sessionId: string | null }> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.handoffId);
    const h = getHandoff(c, c.state.workspaceId, repoId, input.handoffId);
    return await h.attach({ reason: input.reason });
  },

  async pushHandoff(c: any, input: HandoffProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.handoffId);
    const h = getHandoff(c, c.state.workspaceId, repoId, input.handoffId);
    await h.push({ reason: input.reason });
  },

  async syncHandoff(c: any, input: HandoffProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.handoffId);
    const h = getHandoff(c, c.state.workspaceId, repoId, input.handoffId);
    await h.sync({ reason: input.reason });
  },

  async mergeHandoff(c: any, input: HandoffProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.handoffId);
    const h = getHandoff(c, c.state.workspaceId, repoId, input.handoffId);
    await h.merge({ reason: input.reason });
  },

  async archiveHandoff(c: any, input: HandoffProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.handoffId);
    const h = getHandoff(c, c.state.workspaceId, repoId, input.handoffId);
    await h.archive({ reason: input.reason });
  },

  async killHandoff(c: any, input: HandoffProxyActionInput): Promise<void> {
    assertWorkspace(c, input.workspaceId);
    const repoId = await resolveRepoId(c, input.handoffId);
    const h = getHandoff(c, c.state.workspaceId, repoId, input.handoffId);
    await h.kill({ reason: input.reason });
  },
};
