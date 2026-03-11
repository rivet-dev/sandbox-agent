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
import { TASK_QUEUE_NAMES } from "./queue.js";
import {
  changeWorkbenchModel,
  closeWorkbenchSession,
  createWorkbenchSession,
  markWorkbenchUnread,
  publishWorkbenchPr,
  renameWorkbenchBranch,
  renameWorkbenchTask,
  renameWorkbenchSession,
  revertWorkbenchFile,
  sendWorkbenchMessage,
  setWorkbenchSessionUnread,
  stopWorkbenchSession,
  syncWorkbenchSessionStatus,
  updateWorkbenchDraft,
} from "../workbench.js";

export { TASK_QUEUE_NAMES, taskWorkflowQueueName } from "./queue.js";

type TaskQueueName = (typeof TASK_QUEUE_NAMES)[number];

type WorkflowHandler = (loopCtx: any, msg: { name: TaskQueueName; body: any; complete: (response: unknown) => Promise<void> }) => Promise<void>;

const commandHandlers: Record<TaskQueueName, WorkflowHandler> = {
  "task.command.initialize": async (loopCtx, msg) => {
    const body = msg.body;

    await loopCtx.step("init-bootstrap-db", async () => initBootstrapDbActivity(loopCtx, body));
    await loopCtx.removed("init-enqueue-provision", "step");
    await loopCtx.removed("init-dispatch-provision-v2", "step");
    const currentRecord = await loopCtx.step("init-read-current-record", async () => getCurrentRecord(loopCtx));

    try {
      await msg.complete(currentRecord);
    } catch (error) {
      logActorWarning("task.workflow", "initialize completion failed", {
        error: resolveErrorMessage(error),
      });
    }
  },

  "task.command.provision": async (loopCtx, msg) => {
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

  "task.command.attach": async (loopCtx, msg) => {
    await loopCtx.step("handle-attach", async () => handleAttachActivity(loopCtx, msg));
  },

  "task.command.switch": async (loopCtx, msg) => {
    await loopCtx.step("handle-switch", async () => handleSwitchActivity(loopCtx, msg));
  },

  "task.command.push": async (loopCtx, msg) => {
    await loopCtx.step("handle-push", async () => handlePushActivity(loopCtx, msg));
  },

  "task.command.sync": async (loopCtx, msg) => {
    await loopCtx.step("handle-sync", async () => handleSimpleCommandActivity(loopCtx, msg, "sync requested", "task.sync"));
  },

  "task.command.merge": async (loopCtx, msg) => {
    await loopCtx.step("handle-merge", async () => handleSimpleCommandActivity(loopCtx, msg, "merge requested", "task.merge"));
  },

  "task.command.archive": async (loopCtx, msg) => {
    await loopCtx.step("handle-archive", async () => handleArchiveActivity(loopCtx, msg));
  },

  "task.command.kill": async (loopCtx, msg) => {
    await loopCtx.step("kill-destroy-sandbox", async () => killDestroySandboxActivity(loopCtx));
    await loopCtx.step("kill-write-db", async () => killWriteDbActivity(loopCtx, msg));
  },

  "task.command.get": async (loopCtx, msg) => {
    await loopCtx.step("handle-get", async () => handleGetActivity(loopCtx, msg));
  },

  "task.command.workbench.mark_unread": async (loopCtx, msg) => {
    await loopCtx.step("workbench-mark-unread", async () => markWorkbenchUnread(loopCtx));
    await msg.complete({ ok: true });
  },

  "task.command.workbench.rename_task": async (loopCtx, msg) => {
    await loopCtx.step("workbench-rename-task", async () => renameWorkbenchTask(loopCtx, msg.body.value));
    await msg.complete({ ok: true });
  },

  "task.command.workbench.rename_branch": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-rename-branch",
      timeout: 5 * 60_000,
      run: async () => renameWorkbenchBranch(loopCtx, msg.body.value),
    });
    await msg.complete({ ok: true });
  },

  "task.command.workbench.create_session": async (loopCtx, msg) => {
    const created = await loopCtx.step({
      name: "workbench-create-session",
      timeout: 5 * 60_000,
      run: async () => createWorkbenchSession(loopCtx, msg.body?.model),
    });
    await msg.complete(created);
  },

  "task.command.workbench.rename_session": async (loopCtx, msg) => {
    await loopCtx.step("workbench-rename-session", async () => renameWorkbenchSession(loopCtx, msg.body.sessionId, msg.body.title));
    await msg.complete({ ok: true });
  },

  "task.command.workbench.set_session_unread": async (loopCtx, msg) => {
    await loopCtx.step("workbench-set-session-unread", async () => setWorkbenchSessionUnread(loopCtx, msg.body.sessionId, msg.body.unread));
    await msg.complete({ ok: true });
  },

  "task.command.workbench.update_draft": async (loopCtx, msg) => {
    await loopCtx.step("workbench-update-draft", async () => updateWorkbenchDraft(loopCtx, msg.body.sessionId, msg.body.text, msg.body.attachments));
    await msg.complete({ ok: true });
  },

  "task.command.workbench.change_model": async (loopCtx, msg) => {
    await loopCtx.step("workbench-change-model", async () => changeWorkbenchModel(loopCtx, msg.body.sessionId, msg.body.model));
    await msg.complete({ ok: true });
  },

  "task.command.workbench.send_message": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-send-message",
      timeout: 10 * 60_000,
      run: async () => sendWorkbenchMessage(loopCtx, msg.body.sessionId, msg.body.text, msg.body.attachments),
    });
    await msg.complete({ ok: true });
  },

  "task.command.workbench.stop_session": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-stop-session",
      timeout: 5 * 60_000,
      run: async () => stopWorkbenchSession(loopCtx, msg.body.sessionId),
    });
    await msg.complete({ ok: true });
  },

  "task.command.workbench.sync_session_status": async (loopCtx, msg) => {
    await loopCtx.step("workbench-sync-session-status", async () => syncWorkbenchSessionStatus(loopCtx, msg.body.sessionId, msg.body.status, msg.body.at));
    await msg.complete({ ok: true });
  },

  "task.command.workbench.close_session": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-close-session",
      timeout: 5 * 60_000,
      run: async () => closeWorkbenchSession(loopCtx, msg.body.sessionId),
    });
    await msg.complete({ ok: true });
  },

  "task.command.workbench.publish_pr": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-publish-pr",
      timeout: 10 * 60_000,
      run: async () => publishWorkbenchPr(loopCtx),
    });
    await msg.complete({ ok: true });
  },

  "task.command.workbench.revert_file": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-revert-file",
      timeout: 5 * 60_000,
      run: async () => revertWorkbenchFile(loopCtx, msg.body.path),
    });
    await msg.complete({ ok: true });
  },

  "task.status_sync.result": async (loopCtx, msg) => {
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

export async function runTaskWorkflow(ctx: any): Promise<void> {
  await ctx.loop("task-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-command", {
      names: [...TASK_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }
    const handler = commandHandlers[msg.name as TaskQueueName];
    if (handler) {
      await handler(loopCtx, msg);
    }
    return Loop.continue(undefined);
  });
}
