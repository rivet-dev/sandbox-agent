import { Loop } from "rivetkit/workflow";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { getCurrentRecord } from "./common.js";
import { initBootstrapDbActivity, initCompleteActivity, initEnqueueProvisionActivity, initFailedActivity } from "./init.js";
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
import { TASK_QUEUE_NAMES } from "./queue.js";
import {
  changeWorkbenchModel,
  closeWorkbenchSession,
  createWorkbenchSession,
  ensureWorkbenchSession,
  refreshWorkbenchDerivedState,
  refreshWorkbenchSessionTranscript,
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
    await loopCtx.step("init-enqueue-provision", async () => initEnqueueProvisionActivity(loopCtx, body));
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
    await loopCtx.removed("init-failed", "step");
    await loopCtx.removed("init-failed-v2", "step");
    try {
      await loopCtx.removed("init-ensure-name", "step");
      await loopCtx.removed("init-assert-name", "step");
      await loopCtx.removed("init-create-sandbox", "step");
      await loopCtx.removed("init-ensure-agent", "step");
      await loopCtx.removed("init-start-sandbox-instance", "step");
      await loopCtx.removed("init-expose-sandbox", "step");
      await loopCtx.removed("init-create-session", "step");
      await loopCtx.removed("init-write-db", "step");
      await loopCtx.removed("init-start-status-sync", "step");
      await loopCtx.step("init-complete", async () => initCompleteActivity(loopCtx, msg.body));
      await msg.complete({ ok: true });
    } catch (error) {
      await loopCtx.step("init-failed-v3", async () => initFailedActivity(loopCtx, error));
      await msg.complete({
        ok: false,
        error: resolveErrorMessage(error),
      });
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
    try {
      const created = await loopCtx.step({
        name: "workbench-create-session",
        timeout: 5 * 60_000,
        run: async () => createWorkbenchSession(loopCtx, msg.body?.model),
      });
      await msg.complete(created);
    } catch (error) {
      await msg.complete({ error: resolveErrorMessage(error) });
    }
  },

  "task.command.workbench.create_session_and_send": async (loopCtx, msg) => {
    try {
      const created = await loopCtx.step({
        name: "workbench-create-session-for-send",
        timeout: 5 * 60_000,
        run: async () => createWorkbenchSession(loopCtx, msg.body?.model),
      });
      await loopCtx.step({
        name: "workbench-send-initial-message",
        timeout: 5 * 60_000,
        run: async () => sendWorkbenchMessage(loopCtx, created.sessionId, msg.body.text, []),
      });
    } catch (error) {
      logActorWarning("task.workflow", "create_session_and_send failed", {
        error: resolveErrorMessage(error),
      });
    }
    await msg.complete({ ok: true });
  },

  "task.command.workbench.ensure_session": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-ensure-session",
      timeout: 5 * 60_000,
      run: async () => ensureWorkbenchSession(loopCtx, msg.body.sessionId, msg.body?.model),
    });
    await msg.complete({ ok: true });
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
    try {
      await loopCtx.step({
        name: "workbench-send-message",
        timeout: 10 * 60_000,
        run: async () => sendWorkbenchMessage(loopCtx, msg.body.sessionId, msg.body.text, msg.body.attachments),
      });
      await msg.complete({ ok: true });
    } catch (error) {
      await msg.complete({ error: resolveErrorMessage(error) });
    }
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

  "task.command.workbench.refresh_derived": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-refresh-derived",
      timeout: 5 * 60_000,
      run: async () => refreshWorkbenchDerivedState(loopCtx),
    });
    await msg.complete({ ok: true });
  },

  "task.command.workbench.refresh_session_transcript": async (loopCtx, msg) => {
    await loopCtx.step({
      name: "workbench-refresh-session-transcript",
      timeout: 60_000,
      run: async () => refreshWorkbenchSessionTranscript(loopCtx, msg.body.sessionId),
    });
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
      try {
        await handler(loopCtx, msg);
      } catch (error) {
        const message = resolveErrorMessage(error);
        logActorWarning("task.workflow", "task workflow command failed", {
          queueName: msg.name,
          error: message,
        });
        await msg.complete({ error: message }).catch(() => {});
      }
    }
    return Loop.continue(undefined);
  });
}
