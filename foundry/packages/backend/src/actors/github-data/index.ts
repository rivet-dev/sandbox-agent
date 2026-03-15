// @ts-nocheck
import { eq } from "drizzle-orm";
import { actor, queue } from "rivetkit";
import { workflow, Loop } from "rivetkit/workflow";
import type { FoundryOrganization } from "@sandbox-agent/foundry-shared";
import { getActorRuntimeContext } from "../context.js";
import { getOrCreateOrganization, getTask } from "../handles.js";
import { repoIdFromRemote } from "../../services/repo.js";
import { resolveOrganizationGithubAuth } from "../../services/github-auth.js";
import { githubDataDb } from "./db/db.js";
import { githubBranches, githubMembers, githubMeta, githubPullRequests, githubRepositories } from "./db/schema.js";

const META_ROW_ID = 1;

interface GithubDataInput {
  organizationId: string;
}

interface GithubMemberRecord {
  id: string;
  login: string;
  name: string;
  email?: string | null;
  role?: string | null;
  state?: string | null;
}

interface GithubRepositoryRecord {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  defaultBranch: string;
}

interface GithubBranchRecord {
  repoId: string;
  branchName: string;
  commitSha: string;
}

interface GithubPullRequestRecord {
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  authorLogin: string | null;
  isDraft: boolean;
  updatedAt: number;
}

interface FullSyncInput {
  connectedAccount?: string | null;
  installationStatus?: FoundryOrganization["github"]["installationStatus"];
  installationId?: number | null;
  githubLogin?: string | null;
  kind?: FoundryOrganization["kind"] | null;
  accessToken?: string | null;
  label?: string | null;
}

interface ClearStateInput {
  connectedAccount: string;
  installationStatus: FoundryOrganization["github"]["installationStatus"];
  installationId: number | null;
  label: string;
}

interface PullRequestWebhookInput {
  connectedAccount: string;
  installationStatus: FoundryOrganization["github"]["installationStatus"];
  installationId: number | null;
  repository: {
    fullName: string;
    cloneUrl: string;
    private: boolean;
  };
  pullRequest: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    authorLogin: string | null;
    isDraft: boolean;
    merged?: boolean;
  };
}

function normalizePrStatus(input: { state: string; isDraft?: boolean; merged?: boolean }): "OPEN" | "DRAFT" | "CLOSED" | "MERGED" {
  const state = input.state.trim().toUpperCase();
  if (input.merged || state === "MERGED") return "MERGED";
  if (state === "CLOSED") return "CLOSED";
  return input.isDraft ? "DRAFT" : "OPEN";
}

function pullRequestSummaryFromRow(row: any) {
  return {
    prId: row.prId,
    repoId: row.repoId,
    repoFullName: row.repoFullName,
    number: row.number,
    title: row.title,
    state: row.state,
    url: row.url,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    authorLogin: row.authorLogin ?? null,
    isDraft: Boolean(row.isDraft),
    updatedAtMs: row.updatedAt,
  };
}

async function readMeta(c: any) {
  const row = await c.db.select().from(githubMeta).where(eq(githubMeta.id, META_ROW_ID)).get();
  return {
    connectedAccount: row?.connectedAccount ?? "",
    installationStatus: (row?.installationStatus ?? "install_required") as FoundryOrganization["github"]["installationStatus"],
    syncStatus: (row?.syncStatus ?? "pending") as FoundryOrganization["github"]["syncStatus"],
    installationId: row?.installationId ?? null,
    lastSyncLabel: row?.lastSyncLabel ?? "Waiting for first import",
    lastSyncAt: row?.lastSyncAt ?? null,
  };
}

async function writeMeta(c: any, patch: Partial<Awaited<ReturnType<typeof readMeta>>>) {
  const current = await readMeta(c);
  const next = {
    ...current,
    ...patch,
  };
  await c.db
    .insert(githubMeta)
    .values({
      id: META_ROW_ID,
      connectedAccount: next.connectedAccount,
      installationStatus: next.installationStatus,
      syncStatus: next.syncStatus,
      installationId: next.installationId,
      lastSyncLabel: next.lastSyncLabel,
      lastSyncAt: next.lastSyncAt,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({
      target: githubMeta.id,
      set: {
        connectedAccount: next.connectedAccount,
        installationStatus: next.installationStatus,
        syncStatus: next.syncStatus,
        installationId: next.installationId,
        lastSyncLabel: next.lastSyncLabel,
        lastSyncAt: next.lastSyncAt,
        updatedAt: Date.now(),
      },
    })
    .run();
  return next;
}

async function getOrganizationContext(c: any, overrides?: FullSyncInput) {
  const organizationHandle = await getOrCreateOrganization(c, c.state.organizationId);
  const organizationState = await organizationHandle.getOrganizationShellStateIfInitialized({});
  if (!organizationState) {
    throw new Error(`Organization ${c.state.organizationId} is not initialized`);
  }
  const auth = await resolveOrganizationGithubAuth(c, c.state.organizationId);
  return {
    kind: overrides?.kind ?? organizationState.snapshot.kind,
    githubLogin: overrides?.githubLogin ?? organizationState.githubLogin,
    connectedAccount: overrides?.connectedAccount ?? organizationState.snapshot.github.connectedAccount ?? organizationState.githubLogin,
    installationId: overrides?.installationId ?? organizationState.githubInstallationId ?? null,
    installationStatus:
      overrides?.installationStatus ??
      organizationState.snapshot.github.installationStatus ??
      (organizationState.snapshot.kind === "personal" ? "connected" : "reconnect_required"),
    accessToken: overrides?.accessToken ?? auth?.githubToken ?? null,
  };
}

async function replaceRepositories(c: any, repositories: GithubRepositoryRecord[], updatedAt: number) {
  await c.db.delete(githubRepositories).run();
  for (const repository of repositories) {
    await c.db
      .insert(githubRepositories)
      .values({
        repoId: repoIdFromRemote(repository.cloneUrl),
        fullName: repository.fullName,
        cloneUrl: repository.cloneUrl,
        private: repository.private ? 1 : 0,
        defaultBranch: repository.defaultBranch,
        updatedAt,
      })
      .run();
  }
}

async function replaceBranches(c: any, branches: GithubBranchRecord[], updatedAt: number) {
  await c.db.delete(githubBranches).run();
  for (const branch of branches) {
    await c.db
      .insert(githubBranches)
      .values({
        branchId: `${branch.repoId}:${branch.branchName}`,
        repoId: branch.repoId,
        branchName: branch.branchName,
        commitSha: branch.commitSha,
        updatedAt,
      })
      .run();
  }
}

async function replaceMembers(c: any, members: GithubMemberRecord[], updatedAt: number) {
  await c.db.delete(githubMembers).run();
  for (const member of members) {
    await c.db
      .insert(githubMembers)
      .values({
        memberId: member.id,
        login: member.login,
        displayName: member.name || member.login,
        email: member.email ?? null,
        role: member.role ?? null,
        state: member.state ?? "active",
        updatedAt,
      })
      .run();
  }
}

async function replacePullRequests(c: any, pullRequests: GithubPullRequestRecord[]) {
  await c.db.delete(githubPullRequests).run();
  for (const pullRequest of pullRequests) {
    await c.db
      .insert(githubPullRequests)
      .values({
        prId: `${pullRequest.repoId}#${pullRequest.number}`,
        repoId: pullRequest.repoId,
        repoFullName: pullRequest.repoFullName,
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body ?? null,
        state: pullRequest.state,
        url: pullRequest.url,
        headRefName: pullRequest.headRefName,
        baseRefName: pullRequest.baseRefName,
        authorLogin: pullRequest.authorLogin ?? null,
        isDraft: pullRequest.isDraft ? 1 : 0,
        updatedAt: pullRequest.updatedAt,
      })
      .run();
  }
}

async function refreshTaskSummaryForBranch(c: any, repoId: string, branchName: string) {
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  await organization.refreshTaskSummaryForGithubBranch({ repoId, branchName });
}

async function emitPullRequestChangeEvents(c: any, beforeRows: any[], afterRows: any[]) {
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  const beforeById = new Map(beforeRows.map((row) => [row.prId, row]));
  const afterById = new Map(afterRows.map((row) => [row.prId, row]));

  for (const [prId, row] of afterById) {
    const previous = beforeById.get(prId);
    const changed =
      !previous ||
      previous.title !== row.title ||
      previous.state !== row.state ||
      previous.url !== row.url ||
      previous.headRefName !== row.headRefName ||
      previous.baseRefName !== row.baseRefName ||
      previous.authorLogin !== row.authorLogin ||
      previous.isDraft !== row.isDraft ||
      previous.updatedAt !== row.updatedAt;
    if (!changed) {
      continue;
    }
    await organization.applyOpenPullRequestUpdate({
      pullRequest: pullRequestSummaryFromRow(row),
    });
    await refreshTaskSummaryForBranch(c, row.repoId, row.headRefName);
  }

  for (const [prId, row] of beforeById) {
    if (afterById.has(prId)) {
      continue;
    }
    await organization.removeOpenPullRequest({ prId });
    await refreshTaskSummaryForBranch(c, row.repoId, row.headRefName);
  }
}

async function autoArchiveTaskForClosedPullRequest(c: any, row: any) {
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  const match = await organization.findTaskForGithubBranch({
    repoId: row.repoId,
    branchName: row.headRefName,
  });
  if (!match?.taskId) {
    return;
  }
  try {
    const task = getTask(c, c.state.organizationId, row.repoId, match.taskId);
    await task.archive({ reason: `PR ${String(row.state).toLowerCase()}` });
  } catch {
    // Best-effort only. Task summary refresh will still clear the PR state.
  }
}

async function resolveRepositories(c: any, context: Awaited<ReturnType<typeof getOrganizationContext>>): Promise<GithubRepositoryRecord[]> {
  const { appShell } = getActorRuntimeContext();
  if (context.kind === "personal") {
    if (!context.accessToken) {
      return [];
    }
    return await appShell.github.listUserRepositories(context.accessToken);
  }

  if (context.installationId != null) {
    try {
      return await appShell.github.listInstallationRepositories(context.installationId);
    } catch (error) {
      if (!context.accessToken) {
        throw error;
      }
    }
  }

  if (!context.accessToken) {
    return [];
  }

  return (await appShell.github.listUserRepositories(context.accessToken)).filter((repository) => repository.fullName.startsWith(`${context.githubLogin}/`));
}

async function resolveMembers(c: any, context: Awaited<ReturnType<typeof getOrganizationContext>>): Promise<GithubMemberRecord[]> {
  const { appShell } = getActorRuntimeContext();
  if (context.kind === "personal") {
    return [];
  }
  if (context.installationId != null) {
    try {
      return await appShell.github.listInstallationMembers(context.installationId, context.githubLogin);
    } catch (error) {
      if (!context.accessToken) {
        throw error;
      }
    }
  }
  if (!context.accessToken) {
    return [];
  }
  return await appShell.github.listOrganizationMembers(context.accessToken, context.githubLogin);
}

async function resolvePullRequests(
  c: any,
  context: Awaited<ReturnType<typeof getOrganizationContext>>,
  repositories: GithubRepositoryRecord[],
): Promise<GithubPullRequestRecord[]> {
  const { appShell } = getActorRuntimeContext();
  if (repositories.length === 0) {
    return [];
  }

  let pullRequests: Array<{
    repoFullName: string;
    cloneUrl: string;
    number: number;
    title: string;
    body?: string | null;
    state: string;
    url: string;
    headRefName: string;
    baseRefName: string;
    authorLogin?: string | null;
    isDraft?: boolean;
    merged?: boolean;
  }> = [];

  if (context.installationId != null) {
    try {
      pullRequests = await appShell.github.listInstallationPullRequestsForRepositories(context.installationId, repositories);
    } catch (error) {
      if (!context.accessToken) {
        throw error;
      }
    }
  }

  if (pullRequests.length === 0 && context.accessToken) {
    pullRequests = await appShell.github.listPullRequestsForUserRepositories(context.accessToken, repositories);
  }

  return pullRequests.map((pullRequest) => ({
    repoId: repoIdFromRemote(pullRequest.cloneUrl),
    repoFullName: pullRequest.repoFullName,
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body ?? null,
    state: normalizePrStatus(pullRequest),
    url: pullRequest.url,
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
    authorLogin: pullRequest.authorLogin ?? null,
    isDraft: Boolean(pullRequest.isDraft),
    updatedAt: Date.now(),
  }));
}

async function listRepositoryBranchesForContext(
  context: Awaited<ReturnType<typeof getOrganizationContext>>,
  repository: GithubRepositoryRecord,
): Promise<GithubBranchRecord[]> {
  const { appShell } = getActorRuntimeContext();
  let branches: Array<{ name: string; commitSha: string }> = [];

  if (context.installationId != null) {
    try {
      branches = await appShell.github.listInstallationRepositoryBranches(context.installationId, repository.fullName);
    } catch (error) {
      if (!context.accessToken) {
        throw error;
      }
    }
  }

  if (branches.length === 0 && context.accessToken) {
    branches = await appShell.github.listUserRepositoryBranches(context.accessToken, repository.fullName);
  }

  const repoId = repoIdFromRemote(repository.cloneUrl);
  return branches.map((branch) => ({
    repoId,
    branchName: branch.name,
    commitSha: branch.commitSha,
  }));
}

async function resolveBranches(
  _c: any,
  context: Awaited<ReturnType<typeof getOrganizationContext>>,
  repositories: GithubRepositoryRecord[],
): Promise<GithubBranchRecord[]> {
  return (await Promise.all(repositories.map((repository) => listRepositoryBranchesForContext(context, repository)))).flat();
}

async function refreshRepositoryBranches(
  c: any,
  context: Awaited<ReturnType<typeof getOrganizationContext>>,
  repository: GithubRepositoryRecord,
  updatedAt: number,
): Promise<void> {
  const nextBranches = await listRepositoryBranchesForContext(context, repository);
  await c.db
    .delete(githubBranches)
    .where(eq(githubBranches.repoId, repoIdFromRemote(repository.cloneUrl)))
    .run();

  for (const branch of nextBranches) {
    await c.db
      .insert(githubBranches)
      .values({
        branchId: `${branch.repoId}:${branch.branchName}`,
        repoId: branch.repoId,
        branchName: branch.branchName,
        commitSha: branch.commitSha,
        updatedAt,
      })
      .run();
  }
}

async function readAllPullRequestRows(c: any) {
  return await c.db.select().from(githubPullRequests).all();
}

async function runFullSync(c: any, input: FullSyncInput = {}) {
  const startedAt = Date.now();
  const beforeRows = await readAllPullRequestRows(c);
  const context = await getOrganizationContext(c, input);

  await writeMeta(c, {
    connectedAccount: context.connectedAccount,
    installationStatus: context.installationStatus,
    installationId: context.installationId,
    syncStatus: "syncing",
    lastSyncLabel: input.label?.trim() || "Syncing GitHub data...",
  });

  const repositories = await resolveRepositories(c, context);
  const branches = await resolveBranches(c, context, repositories);
  const members = await resolveMembers(c, context);
  const pullRequests = await resolvePullRequests(c, context, repositories);

  await replaceRepositories(c, repositories, startedAt);
  await replaceBranches(c, branches, startedAt);
  await replaceMembers(c, members, startedAt);
  await replacePullRequests(c, pullRequests);

  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  await organization.applyGithubDataProjection({
    connectedAccount: context.connectedAccount,
    installationStatus: context.installationStatus,
    installationId: context.installationId,
    syncStatus: "synced",
    lastSyncLabel: repositories.length > 0 ? `Synced ${repositories.length} repositories` : "No repositories available",
    lastSyncAt: startedAt,
    repositories,
  });

  const meta = await writeMeta(c, {
    connectedAccount: context.connectedAccount,
    installationStatus: context.installationStatus,
    installationId: context.installationId,
    syncStatus: "synced",
    lastSyncLabel: repositories.length > 0 ? `Synced ${repositories.length} repositories` : "No repositories available",
    lastSyncAt: startedAt,
  });

  const afterRows = await readAllPullRequestRows(c);
  await emitPullRequestChangeEvents(c, beforeRows, afterRows);

  return {
    ...meta,
    repositoryCount: repositories.length,
    memberCount: members.length,
    pullRequestCount: afterRows.length,
  };
}

const GITHUB_DATA_QUEUE_NAMES = ["githubData.command.syncRepos"] as const;

async function runGithubDataWorkflow(ctx: any): Promise<void> {
  // Initial sync: if this actor was just created and has never synced,
  // kick off the first full sync automatically.
  await ctx.step({
    name: "github-data-initial-sync",
    timeout: 5 * 60_000,
    run: async () => {
      const meta = await readMeta(ctx);
      if (meta.syncStatus !== "pending") {
        return; // Already synced or syncing — skip initial sync
      }
      try {
        await runFullSync(ctx, { label: "Importing repository catalog..." });
      } catch (error) {
        // Best-effort initial sync. Write the error to meta so the client
        // sees the failure and can trigger a manual retry.
        const currentMeta = await readMeta(ctx);
        const organization = await getOrCreateOrganization(ctx, ctx.state.organizationId);
        await organization.markOrganizationSyncFailed({
          message: error instanceof Error ? error.message : "GitHub import failed",
          installationStatus: currentMeta.installationStatus,
        });
      }
    },
  });

  // Command loop for explicit sync requests (reload, re-import, etc.)
  await ctx.loop("github-data-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-github-data-command", {
      names: [...GITHUB_DATA_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }

    try {
      if (msg.name === "githubData.command.syncRepos") {
        await loopCtx.step({
          name: "github-data-sync-repos",
          timeout: 5 * 60_000,
          run: async () => {
            const body = msg.body as FullSyncInput;
            await runFullSync(loopCtx, body);
          },
        });
        await msg.complete({ ok: true });
        return Loop.continue(undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await msg.complete({ error: message }).catch(() => {});
    }

    return Loop.continue(undefined);
  });
}

export const githubData = actor({
  db: githubDataDb,
  queues: Object.fromEntries(GITHUB_DATA_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "GitHub Data",
    icon: "github",
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, input: GithubDataInput) => ({
    organizationId: input.organizationId,
  }),
  run: workflow(runGithubDataWorkflow),
  actions: {
    async getSummary(c) {
      const repositories = await c.db.select().from(githubRepositories).all();
      const branches = await c.db.select().from(githubBranches).all();
      const members = await c.db.select().from(githubMembers).all();
      const pullRequests = await c.db.select().from(githubPullRequests).all();
      return {
        ...(await readMeta(c)),
        repositoryCount: repositories.length,
        branchCount: branches.length,
        memberCount: members.length,
        pullRequestCount: pullRequests.length,
      };
    },

    async listRepositories(c) {
      const rows = await c.db.select().from(githubRepositories).all();
      return rows.map((row) => ({
        repoId: row.repoId,
        fullName: row.fullName,
        cloneUrl: row.cloneUrl,
        private: Boolean(row.private),
        defaultBranch: row.defaultBranch,
      }));
    },

    async getRepository(c, input: { repoId: string }) {
      const row = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, input.repoId)).get();
      if (!row) {
        return null;
      }
      return {
        repoId: row.repoId,
        fullName: row.fullName,
        cloneUrl: row.cloneUrl,
        private: Boolean(row.private),
        defaultBranch: row.defaultBranch,
      };
    },

    async listPullRequestsForRepository(c, input: { repoId: string }) {
      const rows = await c.db.select().from(githubPullRequests).where(eq(githubPullRequests.repoId, input.repoId)).all();
      return rows.map(pullRequestSummaryFromRow);
    },

    async listBranchesForRepository(c, input: { repoId: string }) {
      const rows = await c.db.select().from(githubBranches).where(eq(githubBranches.repoId, input.repoId)).all();
      return rows
        .map((row) => ({
          branchName: row.branchName,
          commitSha: row.commitSha,
        }))
        .sort((left, right) => left.branchName.localeCompare(right.branchName));
    },

    async listOpenPullRequests(c) {
      const rows = await c.db.select().from(githubPullRequests).all();
      return rows.map(pullRequestSummaryFromRow).sort((left, right) => right.updatedAtMs - left.updatedAtMs);
    },

    async getPullRequestForBranch(c, input: { repoId: string; branchName: string }) {
      const rows = await c.db.select().from(githubPullRequests).where(eq(githubPullRequests.repoId, input.repoId)).all();
      const match = rows.find((candidate) => candidate.headRefName === input.branchName) ?? null;
      if (!match) {
        return null;
      }
      return {
        number: match.number,
        status: match.isDraft ? ("draft" as const) : ("ready" as const),
      };
    },

    async fullSync(c, input: FullSyncInput = {}) {
      return await runFullSync(c, input);
    },

    async reloadOrganization(c) {
      return await runFullSync(c, { label: "Reloading GitHub organization..." });
    },

    async reloadAllPullRequests(c) {
      return await runFullSync(c, { label: "Reloading GitHub pull requests..." });
    },

    async reloadRepository(c, input: { repoId: string }) {
      const context = await getOrganizationContext(c);
      const current = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, input.repoId)).get();
      if (!current) {
        throw new Error(`Unknown GitHub repository: ${input.repoId}`);
      }
      const { appShell } = getActorRuntimeContext();
      const repository =
        context.installationId != null
          ? await appShell.github.getInstallationRepository(context.installationId, current.fullName)
          : context.accessToken
            ? await appShell.github.getUserRepository(context.accessToken, current.fullName)
            : null;
      if (!repository) {
        throw new Error(`Unable to reload repository: ${current.fullName}`);
      }

      const updatedAt = Date.now();
      await c.db
        .insert(githubRepositories)
        .values({
          repoId: input.repoId,
          fullName: repository.fullName,
          cloneUrl: repository.cloneUrl,
          private: repository.private ? 1 : 0,
          defaultBranch: repository.defaultBranch,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: githubRepositories.repoId,
          set: {
            fullName: repository.fullName,
            cloneUrl: repository.cloneUrl,
            private: repository.private ? 1 : 0,
            defaultBranch: repository.defaultBranch,
            updatedAt,
          },
        })
        .run();
      await refreshRepositoryBranches(
        c,
        context,
        {
          fullName: repository.fullName,
          cloneUrl: repository.cloneUrl,
          private: repository.private,
          defaultBranch: repository.defaultBranch,
        },
        updatedAt,
      );

      const organization = await getOrCreateOrganization(c, c.state.organizationId);
      await organization.applyGithubRepositoryProjection({
        repoId: input.repoId,
        remoteUrl: repository.cloneUrl,
      });
      return {
        repoId: input.repoId,
        fullName: repository.fullName,
        cloneUrl: repository.cloneUrl,
        private: repository.private,
        defaultBranch: repository.defaultBranch,
      };
    },

    async reloadPullRequest(c, input: { repoId: string; prNumber: number }) {
      const repository = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, input.repoId)).get();
      if (!repository) {
        throw new Error(`Unknown GitHub repository: ${input.repoId}`);
      }
      const context = await getOrganizationContext(c);
      const { appShell } = getActorRuntimeContext();
      const pullRequest =
        context.installationId != null
          ? await appShell.github.getInstallationPullRequest(context.installationId, repository.fullName, input.prNumber)
          : context.accessToken
            ? await appShell.github.getUserPullRequest(context.accessToken, repository.fullName, input.prNumber)
            : null;
      if (!pullRequest) {
        throw new Error(`Unable to reload pull request #${input.prNumber} for ${repository.fullName}`);
      }

      const beforeRows = await readAllPullRequestRows(c);
      const updatedAt = Date.now();
      const nextState = normalizePrStatus(pullRequest);
      const prId = `${input.repoId}#${input.prNumber}`;
      if (nextState === "CLOSED" || nextState === "MERGED") {
        await c.db.delete(githubPullRequests).where(eq(githubPullRequests.prId, prId)).run();
      } else {
        await c.db
          .insert(githubPullRequests)
          .values({
            prId,
            repoId: input.repoId,
            repoFullName: repository.fullName,
            number: pullRequest.number,
            title: pullRequest.title,
            body: pullRequest.body ?? null,
            state: nextState,
            url: pullRequest.url,
            headRefName: pullRequest.headRefName,
            baseRefName: pullRequest.baseRefName,
            authorLogin: pullRequest.authorLogin ?? null,
            isDraft: pullRequest.isDraft ? 1 : 0,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: githubPullRequests.prId,
            set: {
              title: pullRequest.title,
              body: pullRequest.body ?? null,
              state: nextState,
              url: pullRequest.url,
              headRefName: pullRequest.headRefName,
              baseRefName: pullRequest.baseRefName,
              authorLogin: pullRequest.authorLogin ?? null,
              isDraft: pullRequest.isDraft ? 1 : 0,
              updatedAt,
            },
          })
          .run();
      }

      const afterRows = await readAllPullRequestRows(c);
      await emitPullRequestChangeEvents(c, beforeRows, afterRows);
      const closed = afterRows.find((row) => row.prId === prId);
      if (!closed && (nextState === "CLOSED" || nextState === "MERGED")) {
        const previous = beforeRows.find((row) => row.prId === prId);
        if (previous) {
          await autoArchiveTaskForClosedPullRequest(c, {
            ...previous,
            state: nextState,
          });
        }
      }
      return pullRequestSummaryFromRow(
        afterRows.find((row) => row.prId === prId) ?? {
          prId,
          repoId: input.repoId,
          repoFullName: repository.fullName,
          number: input.prNumber,
          title: pullRequest.title,
          state: nextState,
          url: pullRequest.url,
          headRefName: pullRequest.headRefName,
          baseRefName: pullRequest.baseRefName,
          authorLogin: pullRequest.authorLogin ?? null,
          isDraft: pullRequest.isDraft ? 1 : 0,
          updatedAt,
        },
      );
    },

    async clearState(c, input: ClearStateInput) {
      const beforeRows = await readAllPullRequestRows(c);
      await c.db.delete(githubPullRequests).run();
      await c.db.delete(githubBranches).run();
      await c.db.delete(githubRepositories).run();
      await c.db.delete(githubMembers).run();
      await writeMeta(c, {
        connectedAccount: input.connectedAccount,
        installationStatus: input.installationStatus,
        installationId: input.installationId,
        syncStatus: "pending",
        lastSyncLabel: input.label,
        lastSyncAt: null,
      });

      const organization = await getOrCreateOrganization(c, c.state.organizationId);
      await organization.applyGithubDataProjection({
        connectedAccount: input.connectedAccount,
        installationStatus: input.installationStatus,
        installationId: input.installationId,
        syncStatus: "pending",
        lastSyncLabel: input.label,
        lastSyncAt: null,
        repositories: [],
      });
      await emitPullRequestChangeEvents(c, beforeRows, []);
    },

    async handlePullRequestWebhook(c, input: PullRequestWebhookInput) {
      const beforeRows = await readAllPullRequestRows(c);
      const repoId = repoIdFromRemote(input.repository.cloneUrl);
      const currentRepository = await c.db.select().from(githubRepositories).where(eq(githubRepositories.repoId, repoId)).get();
      const updatedAt = Date.now();
      const state = normalizePrStatus(input.pullRequest);
      const prId = `${repoId}#${input.pullRequest.number}`;

      await c.db
        .insert(githubRepositories)
        .values({
          repoId,
          fullName: input.repository.fullName,
          cloneUrl: input.repository.cloneUrl,
          private: input.repository.private ? 1 : 0,
          defaultBranch: currentRepository?.defaultBranch ?? input.pullRequest.baseRefName ?? "main",
          updatedAt,
        })
        .onConflictDoUpdate({
          target: githubRepositories.repoId,
          set: {
            fullName: input.repository.fullName,
            cloneUrl: input.repository.cloneUrl,
            private: input.repository.private ? 1 : 0,
            defaultBranch: currentRepository?.defaultBranch ?? input.pullRequest.baseRefName ?? "main",
            updatedAt,
          },
        })
        .run();

      if (state === "CLOSED" || state === "MERGED") {
        await c.db.delete(githubPullRequests).where(eq(githubPullRequests.prId, prId)).run();
      } else {
        await c.db
          .insert(githubPullRequests)
          .values({
            prId,
            repoId,
            repoFullName: input.repository.fullName,
            number: input.pullRequest.number,
            title: input.pullRequest.title,
            body: input.pullRequest.body ?? null,
            state,
            url: input.pullRequest.url,
            headRefName: input.pullRequest.headRefName,
            baseRefName: input.pullRequest.baseRefName,
            authorLogin: input.pullRequest.authorLogin ?? null,
            isDraft: input.pullRequest.isDraft ? 1 : 0,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: githubPullRequests.prId,
            set: {
              title: input.pullRequest.title,
              body: input.pullRequest.body ?? null,
              state,
              url: input.pullRequest.url,
              headRefName: input.pullRequest.headRefName,
              baseRefName: input.pullRequest.baseRefName,
              authorLogin: input.pullRequest.authorLogin ?? null,
              isDraft: input.pullRequest.isDraft ? 1 : 0,
              updatedAt,
            },
          })
          .run();
      }

      await writeMeta(c, {
        connectedAccount: input.connectedAccount,
        installationStatus: input.installationStatus,
        installationId: input.installationId,
        syncStatus: "synced",
        lastSyncLabel: "GitHub webhook received",
        lastSyncAt: updatedAt,
      });

      const organization = await getOrCreateOrganization(c, c.state.organizationId);
      await organization.applyGithubRepositoryProjection({
        repoId,
        remoteUrl: input.repository.cloneUrl,
      });

      const afterRows = await readAllPullRequestRows(c);
      await emitPullRequestChangeEvents(c, beforeRows, afterRows);
      if (state === "CLOSED" || state === "MERGED") {
        const previous = beforeRows.find((row) => row.prId === prId);
        if (previous) {
          await autoArchiveTaskForClosedPullRequest(c, {
            ...previous,
            state,
          });
        }
      }
    },
  },
});
