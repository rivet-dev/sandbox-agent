import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type { ProviderId } from "@sandbox-agent/foundry-shared";
import { getHandoff, getSandboxInstance, selfHandoffStatusSync } from "../handles.js";
import { logActorWarning, resolveErrorMessage, resolveErrorStack } from "../logging.js";
import { type PollingControlState, runWorkflowPollingLoop } from "../polling.js";

export interface HandoffStatusSyncInput {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  providerId: ProviderId;
  sandboxId: string;
  sessionId: string;
  intervalMs: number;
}

interface SetIntervalCommand {
  intervalMs: number;
}

interface HandoffStatusSyncState extends PollingControlState {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  providerId: ProviderId;
  sandboxId: string;
  sessionId: string;
}

const CONTROL = {
  start: "handoff.status_sync.control.start",
  stop: "handoff.status_sync.control.stop",
  setInterval: "handoff.status_sync.control.set_interval",
  force: "handoff.status_sync.control.force",
} as const;

async function pollSessionStatus(c: { state: HandoffStatusSyncState }): Promise<void> {
  const sandboxInstance = getSandboxInstance(c, c.state.workspaceId, c.state.providerId, c.state.sandboxId);
  const status = await sandboxInstance.sessionStatus({ sessionId: c.state.sessionId });

  const parent = getHandoff(c, c.state.workspaceId, c.state.repoId, c.state.handoffId);
  await parent.syncWorkbenchSessionStatus({
    sessionId: c.state.sessionId,
    status: status.status,
    at: Date.now(),
  });
}

export const handoffStatusSync = actor({
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
  createState: (_c, input: HandoffStatusSyncInput): HandoffStatusSyncState => ({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    handoffId: input.handoffId,
    providerId: input.providerId,
    sandboxId: input.sandboxId,
    sessionId: input.sessionId,
    intervalMs: input.intervalMs,
    running: true,
  }),
  actions: {
    async start(c): Promise<void> {
      const self = selfHandoffStatusSync(c);
      await self.send(CONTROL.start, {}, { wait: true, timeout: 15_000 });
    },

    async stop(c): Promise<void> {
      const self = selfHandoffStatusSync(c);
      await self.send(CONTROL.stop, {}, { wait: true, timeout: 15_000 });
    },

    async setIntervalMs(c, payload: SetIntervalCommand): Promise<void> {
      const self = selfHandoffStatusSync(c);
      await self.send(CONTROL.setInterval, payload, { wait: true, timeout: 15_000 });
    },

    async force(c): Promise<void> {
      const self = selfHandoffStatusSync(c);
      await self.send(CONTROL.force, {}, { wait: true, timeout: 5 * 60_000 });
    },
  },
  run: workflow(async (ctx) => {
    await runWorkflowPollingLoop<HandoffStatusSyncState>(ctx, {
      loopName: "handoff-status-sync-loop",
      control: CONTROL,
      onPoll: async (loopCtx) => {
        try {
          await pollSessionStatus(loopCtx);
        } catch (error) {
          logActorWarning("handoff-status-sync", "poll failed", {
            error: resolveErrorMessage(error),
            stack: resolveErrorStack(error),
          });
        }
      },
    });
  }),
});
