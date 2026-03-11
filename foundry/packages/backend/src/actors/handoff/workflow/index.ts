import { Loop } from "rivetkit/workflow";
import { getActorRuntimeContext } from "../../context.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { getCurrentRecord } from "./common.js";
import {
  initAssertNameActivity,
  initBootstrapDbActivity,
  initCompleteActivity,
  initCreateSandboxActivity,
  initCreateSessionActivity,
  initEnsureAgentActivity,
  initEnsureNameActivity,
  initExposeSandboxActivity,
  initFailedActivity,
  initStartSandboxInstanceActivity,
  initStartStatusSyncActivity,
  initWriteDbActivity,
} from "./init.js";
import {
  handleArchiveActivity,
  handleAttachActivity,
  handleGetActivity,
  handlePushActivity,
  handleSimpleCommandActivity,
  handleSwitchActivity,
  killDestroySandboxActivity,
  killWriteDbActivity,
} from "./commands.js";
import { idleNotifyActivity, idleSubmitPrActivity, statusUpdateActivity } from "./status-sync.js";
import { HANDOFF_QUEUE_NAMES } from "./queue.js";
import {
  changeWorkbenchModel,
  closeWorkbenchSession,
  createWorkbenchSession,
  markWorkbenchUnread,
  publishWorkbenchPr,
  renameWorkbenchBranch,
  renameWorkbenchHandoff,
  renameWorkbenchSession,
  revertWorkbenchFile,
  sendWorkbenchMessage,
  setWorkbenchSessionUnread,
  stopWorkbenchSession,
  syncWorkbenchSessionStatus,
  updateWorkbenchDraft,
} from "../workbench.js";

export { HANDOFF_QUEUE_NAMES, handoffWorkflowQueueName } from "./queue.js";

type HandoffQueueName = (typeof HANDOFF_QUEUE_NAMES)[number];

type WorkflowHandler = (loopCtx: any, msg: { name: HandoffQueueName; body: any; complete: (response: unknown) => Promise<void> }) => Promise<void>;

const commandHandlers: Record<HandoffQueueName, WorkflowHandler> = {
  "handoff.command.initialize": async (loopCtx, msg) => {
    const body = msg.body;

    await loopCtx.step("init-bootstrap-db", async () => initBootstrapDbActivity(loopCtx, body));
    await loopCtx.removed("init-enqueue-provision", "step");
    await loopCtx.removed("init-dispatch-provision-v2", "step");
    const currentRecord = await loopCtx.step("init-read-current-record", async () => getCurrentRecord(loopCtx));

    try {
      await msg.complete(currentRecord);
    } catch (error) {
      logActorWarning("handoff.workflow", "initialize completion failed", {
        error: resolveErrorMessage(error),
      });
    }
  },

  "handoff.command.provision": async (loopCtx, msg) => {
    const body = msg.body;
    await loopCtx.removed("init-failed", "step");
    try {
      await loopCtx.step("init-ensure-name", async () => initEnsureNameActivity(loopCtx));
      await loopCtx.step("init-assert-name", async () => initAssertNameActivity(loopCtx));

      const sandbox = await loopCtx.step({
        name: "init-create-sandbox",
        timeout: 180_000,
        run: async () => initCreateSandboxActivity(loopCtx, body),
      });
      const agent = await loopCtx.step({
        name: "init-ensure-agent",
        timeout: 180_000,
        run: async () => initEnsureAgentActivity(loopCtx, body, sandbox),
      });
      const sandboxInstanceReady = await loopCtx.step({
        name: "init-start-sandbox-instance",
        timeout: 60_000,
        run: async () => initStartSandboxInstanceActivity(loopCtx, body, sandbox, agent),
      });
      await loopCtx.step("init-expose-sandbox", async () => initExposeSandboxActivity(loopCtx, body, sandbox, sandboxInstanceReady));
      const session = await loopCtx.step({
        name: "init-create-session",
        timeout: 180_000,
        run: async () => initCreateSessionActivity(loopCtx, body, sandbox, sandboxInstanceReady),
      });

      await loopCtx.step("init-write-db", async () => initWriteDbActivity(loopCtx, body, sandbox, session, sandboxInstanceReady));
      await loopCtx.step("init-start-status-sync", async () => initStartStatusSyncActivity(loopCtx, body, sandbox, session));
      await loopCtx.step("init-complete", async () => initCompleteActivity(loopCtx, body, sandbox, session));
      await msg.complete({ ok: true });
    } catch (error) {
      await loopCtx.step("init-failed-v2", async () => initFailedActivity(loopCtx, error));
      await msg.complete({ ok: false });
    }
  },

  "handoff.command.attach": async (loopCtx, msg) => {
    await loopCtx.step("handle-attach", async () => handleAttachActivity(loopCtx, msg));
  },

  "handoff.command.switch": async (loopCtx, msg) => {
    await loopCtx.step("handle-switch", async () => handleSwitchActivity(loopCtx, msg));
  },

  "handoff.command.push": async (loopCtx, msg) => {
    await loopCtx.step("handle-push", async () => handlePushActivity(loopCtx, msg));
  },

  "handoff.command.sync": async (loopCtx, msg) => {
    await loopCtx.step("handle-sync", async () => handleSimpleCommandActivity(loopCtx, msg, "sync requested", "handoff.sync"));
  },

  "handoff.command.merge": async (loopCtx, msg) => {
    await loopCtx.step("handle-merge", async () => handleSimpleCommandActivity(loopCtx, msg, "merge requested", "handoff.merge"));
  },

  "handoff.command.archive": async (loopCtx, msg) => {
    await loopCtx.step("handle-archive", async () => handleArchiveActivity(loopCtx, msg));
  },

  "handoff.command.kill": async (loopCtx, msg) => {
    await loopCtx.step("kill-destroy-sandbox", async () => killDestroySandboxActivity(loopCtx));
    await loopCtx.step("kill-write-db", async () => killWriteDbActivity(loopCtx, msg));
  },

  "handoff.command.get": async (loopCtx, msg) => {
    await loopCtx.step("handle-get", async () => handleGetActivity(loopCtx, msg));
  },

  "handoff.command.workbench.mark_unread": async (loopCtx, msg) => {
    await loopCtx.step("workbench-mark-unread", async () => markWorkbenchUnread(loopCtx));
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.rename_handoff": async (loopCtx, msg) => {
    await loopCtx.step("workbench-rename-handoff", async () => renameWorkbenchHandoff(loopCtx, msg.body.value));
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.rename_branch": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-rename-branch",
      timeout: 5 * 60_000,
      run: async () => renameWorkbenchBranch(loopCtx, msg.body.value),
    });
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.create_session": async (loopCtx, msg) => {
    const created = await loopCtx.step({
      name: "workbench-create-session",
      timeout: 5 * 60_000,
      run: async () => createWorkbenchSession(loopCtx, msg.body?.model),
    });
    await msg.complete(created);
  },

  "handoff.command.workbench.rename_session": async (loopCtx, msg) => {
    await loopCtx.step("workbench-rename-session", async () => renameWorkbenchSession(loopCtx, msg.body.sessionId, msg.body.title));
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.set_session_unread": async (loopCtx, msg) => {
    await loopCtx.step("workbench-set-session-unread", async () => setWorkbenchSessionUnread(loopCtx, msg.body.sessionId, msg.body.unread));
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.update_draft": async (loopCtx, msg) => {
    await loopCtx.step("workbench-update-draft", async () => updateWorkbenchDraft(loopCtx, msg.body.sessionId, msg.body.text, msg.body.attachments));
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.change_model": async (loopCtx, msg) => {
    await loopCtx.step("workbench-change-model", async () => changeWorkbenchModel(loopCtx, msg.body.sessionId, msg.body.model));
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.send_message": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-send-message",
      timeout: 10 * 60_000,
      run: async () => sendWorkbenchMessage(loopCtx, msg.body.sessionId, msg.body.text, msg.body.attachments),
    });
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.stop_session": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-stop-session",
      timeout: 5 * 60_000,
      run: async () => stopWorkbenchSession(loopCtx, msg.body.sessionId),
    });
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.sync_session_status": async (loopCtx, msg) => {
    await loopCtx.step("workbench-sync-session-status", async () => syncWorkbenchSessionStatus(loopCtx, msg.body.sessionId, msg.body.status, msg.body.at));
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.close_session": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-close-session",
      timeout: 5 * 60_000,
      run: async () => closeWorkbenchSession(loopCtx, msg.body.sessionId),
    });
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.publish_pr": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-publish-pr",
      timeout: 10 * 60_000,
      run: async () => publishWorkbenchPr(loopCtx),
    });
    await msg.complete({ ok: true });
  },

  "handoff.command.workbench.revert_file": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-revert-file",
      timeout: 5 * 60_000,
      run: async () => revertWorkbenchFile(loopCtx, msg.body.path),
    });
    await msg.complete({ ok: true });
  },

  "handoff.status_sync.result": async (loopCtx, msg) => {
    const transitionedToIdle = await loopCtx.step("status-update", async () => statusUpdateActivity(loopCtx, msg.body));

    if (transitionedToIdle) {
      const { config } = getActorRuntimeContext();
      if (config.auto_submit) {
        await loopCtx.step("idle-submit-pr", async () => idleSubmitPrActivity(loopCtx));
      }
      await loopCtx.step("idle-notify", async () => idleNotifyActivity(loopCtx));
    }
  },
};

export async function runHandoffWorkflow(ctx: any): Promise<void> {
  await ctx.loop("handoff-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-command", {
      names: [...HANDOFF_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }
    const handler = commandHandlers[msg.name as HandoffQueueName];
    if (handler) {
      await handler(loopCtx, msg);
    }
    return Loop.continue(undefined);
  });
}
