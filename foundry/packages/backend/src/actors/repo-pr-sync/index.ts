import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import { getActorRuntimeContext } from "../context.js";
import { getRepo, selfRepoPrSync } from "../handles.js";
import { logActorWarning, resolveErrorMessage, resolveErrorStack } from "../logging.js";
import { type PollingControlState, runWorkflowPollingLoop } from "../polling.js";

export interface RepoPrSyncInput {
  workspaceId: string;
  repoId: string;
  repoPath: string;
  intervalMs: number;
}

interface SetIntervalCommand {
  intervalMs: number;
}

interface RepoPrSyncState extends PollingControlState {
  workspaceId: string;
  repoId: string;
  repoPath: string;
}

const CONTROL = {
  start: "repo.pr_sync.control.start",
  stop: "repo.pr_sync.control.stop",
  setInterval: "repo.pr_sync.control.set_interval",
  force: "repo.pr_sync.control.force",
} as const;

async function pollPrs(c: { state: RepoPrSyncState }): Promise<void> {
  const { driver } = getActorRuntimeContext();
  const items = await driver.github.listPullRequests(c.state.repoPath);
  const parent = getRepo(c, c.state.workspaceId, c.state.repoId);
  await parent.applyPrSyncResult({ items, at: Date.now() });
}

export const repoPrSync = actor({
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
  createState: (_c, input: RepoPrSyncInput): RepoPrSyncState => ({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    repoPath: input.repoPath,
    intervalMs: input.intervalMs,
    running: true,
  }),
  actions: {
    async start(c): Promise<void> {
      const self = selfRepoPrSync(c);
      await self.send(CONTROL.start, {}, { wait: true, timeout: 15_000 });
    },

    async stop(c): Promise<void> {
      const self = selfRepoPrSync(c);
      await self.send(CONTROL.stop, {}, { wait: true, timeout: 15_000 });
    },

    async setIntervalMs(c, payload: SetIntervalCommand): Promise<void> {
      const self = selfRepoPrSync(c);
      await self.send(CONTROL.setInterval, payload, { wait: true, timeout: 15_000 });
    },

    async force(c): Promise<void> {
      const self = selfRepoPrSync(c);
      await self.send(CONTROL.force, {}, { wait: true, timeout: 5 * 60_000 });
    },
  },
  run: workflow(async (ctx) => {
    await runWorkflowPollingLoop<RepoPrSyncState>(ctx, {
      loopName: "repo-pr-sync-loop",
      control: CONTROL,
      onPoll: async (loopCtx) => {
        try {
          await pollPrs(loopCtx);
        } catch (error) {
          logActorWarning("repo-pr-sync", "poll failed", {
            error: resolveErrorMessage(error),
            stack: resolveErrorStack(error),
          });
        }
      },
    });
  }),
});
