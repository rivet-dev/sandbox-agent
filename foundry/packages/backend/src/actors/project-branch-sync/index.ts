import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { GitDriver } from "../../driver.js";
import { getActorRuntimeContext } from "../context.js";
import { getProject, selfProjectBranchSync } from "../handles.js";
import { logActorWarning, resolveErrorMessage, resolveErrorStack } from "../logging.js";
import { type PollingControlState, runWorkflowPollingLoop } from "../polling.js";
import { parentLookupFromStack } from "../project/stack-model.js";
import { withRepoGitLock } from "../../services/repo-git-lock.js";

export interface ProjectBranchSyncInput {
  workspaceId: string;
  repoId: string;
  repoPath: string;
  intervalMs: number;
}

interface SetIntervalCommand {
  intervalMs: number;
}

interface EnrichedBranchSnapshot {
  branchName: string;
  commitSha: string;
  parentBranch: string | null;
  trackedInStack: boolean;
  diffStat: string | null;
  hasUnpushed: boolean;
  conflictsWithMain: boolean;
}

interface ProjectBranchSyncState extends PollingControlState {
  workspaceId: string;
  repoId: string;
  repoPath: string;
}

const CONTROL = {
  start: "project.branch_sync.control.start",
  stop: "project.branch_sync.control.stop",
  setInterval: "project.branch_sync.control.set_interval",
  force: "project.branch_sync.control.force",
} as const;

async function enrichBranches(workspaceId: string, repoId: string, repoPath: string, git: GitDriver): Promise<EnrichedBranchSnapshot[]> {
  return await withRepoGitLock(repoPath, async () => {
    await git.fetch(repoPath);
    const branches = await git.listRemoteBranches(repoPath);
    const { driver } = getActorRuntimeContext();
    const stackEntries = await driver.stack.listStack(repoPath).catch(() => []);
    const parentByBranch = parentLookupFromStack(stackEntries);
    const enriched: EnrichedBranchSnapshot[] = [];

    const baseRef = await git.remoteDefaultBaseRef(repoPath);
    const baseSha = await git.revParse(repoPath, baseRef).catch(() => "");

    for (const branch of branches) {
      let branchDiffStat: string | null = null;
      let branchHasUnpushed = false;
      let branchConflicts = false;

      try {
        branchDiffStat = await git.diffStatForBranch(repoPath, branch.branchName);
      } catch (error) {
        logActorWarning("project-branch-sync", "diffStatForBranch failed", {
          workspaceId,
          repoId,
          branchName: branch.branchName,
          error: resolveErrorMessage(error),
        });
        branchDiffStat = null;
      }

      try {
        const headSha = await git.revParse(repoPath, `origin/${branch.branchName}`);
        branchHasUnpushed = Boolean(baseSha && headSha && headSha !== baseSha);
      } catch (error) {
        logActorWarning("project-branch-sync", "revParse failed", {
          workspaceId,
          repoId,
          branchName: branch.branchName,
          error: resolveErrorMessage(error),
        });
        branchHasUnpushed = false;
      }

      try {
        branchConflicts = await git.conflictsWithMain(repoPath, branch.branchName);
      } catch (error) {
        logActorWarning("project-branch-sync", "conflictsWithMain failed", {
          workspaceId,
          repoId,
          branchName: branch.branchName,
          error: resolveErrorMessage(error),
        });
        branchConflicts = false;
      }

      enriched.push({
        branchName: branch.branchName,
        commitSha: branch.commitSha,
        parentBranch: parentByBranch.get(branch.branchName) ?? null,
        trackedInStack: parentByBranch.has(branch.branchName),
        diffStat: branchDiffStat,
        hasUnpushed: branchHasUnpushed,
        conflictsWithMain: branchConflicts,
      });
    }

    return enriched;
  });
}

async function pollBranches(c: { state: ProjectBranchSyncState }): Promise<void> {
  const { driver } = getActorRuntimeContext();
  const enrichedItems = await enrichBranches(c.state.workspaceId, c.state.repoId, c.state.repoPath, driver.git);
  const parent = getProject(c, c.state.workspaceId, c.state.repoId);
  await parent.applyBranchSyncResult({ items: enrichedItems, at: Date.now() });
}

export const projectBranchSync = actor({
  queues: {
    [CONTROL.start]: queue(),
    [CONTROL.stop]: queue(),
    [CONTROL.setInterval]: queue(),
    [CONTROL.force]: queue(),
  },
  options: {
    // Polling actors rely on timer-based wakeups; sleeping would pause the timer and stop polling.
    noSleep: true,
  },
  createState: (_c, input: ProjectBranchSyncInput): ProjectBranchSyncState => ({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    repoPath: input.repoPath,
    intervalMs: input.intervalMs,
    running: true,
  }),
  actions: {
    async start(c): Promise<void> {
      const self = selfProjectBranchSync(c);
      await self.send(CONTROL.start, {}, { wait: true, timeout: 15_000 });
    },

    async stop(c): Promise<void> {
      const self = selfProjectBranchSync(c);
      await self.send(CONTROL.stop, {}, { wait: true, timeout: 15_000 });
    },

    async setIntervalMs(c, payload: SetIntervalCommand): Promise<void> {
      const self = selfProjectBranchSync(c);
      await self.send(CONTROL.setInterval, payload, { wait: true, timeout: 15_000 });
    },

    async force(c): Promise<void> {
      const self = selfProjectBranchSync(c);
      await self.send(CONTROL.force, {}, { wait: true, timeout: 5 * 60_000 });
    },
  },
  run: workflow(async (ctx) => {
    await runWorkflowPollingLoop<ProjectBranchSyncState>(ctx, {
      loopName: "project-branch-sync-loop",
      control: CONTROL,
      onPoll: async (loopCtx) => {
        try {
          await pollBranches(loopCtx);
        } catch (error) {
          logActorWarning("project-branch-sync", "poll failed", {
            error: resolveErrorMessage(error),
            stack: resolveErrorStack(error),
          });
        }
      },
    });
  }),
});
