import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type {
  AgentType,
  TaskRecord,
  TaskWorkbenchChangeModelInput,
  TaskWorkbenchRenameInput,
  TaskWorkbenchRenameSessionInput,
  TaskWorkbenchSetSessionUnreadInput,
  TaskWorkbenchSendMessageInput,
  TaskWorkbenchUpdateDraftInput,
  SandboxProviderId,
} from "@sandbox-agent/foundry-shared";
import { expectQueueResponse } from "../../services/queue.js";
import { selfTask } from "../handles.js";
import { taskDb } from "./db/db.js";
import { getCurrentRecord } from "./workflow/common.js";
import {
  changeWorkbenchModel,
  closeWorkbenchSession,
  createWorkbenchSession,
  getSessionDetail,
  getTaskDetail,
  getTaskSummary,
  markWorkbenchUnread,
  publishWorkbenchPr,
  renameWorkbenchBranch,
  renameWorkbenchTask,
  renameWorkbenchSession,
  revertWorkbenchFile,
  sendWorkbenchMessage,
  syncWorkbenchSessionStatus,
  setWorkbenchSessionUnread,
  stopWorkbenchSession,
  updateWorkbenchDraft,
} from "./workbench.js";
import { TASK_QUEUE_NAMES, taskWorkflowQueueName, runTaskWorkflow } from "./workflow/index.js";

export interface TaskInput {
  organizationId: string;
  repoId: string;
  taskId: string;
  repoRemote: string;
  branchName: string | null;
  title: string | null;
  task: string;
  sandboxProviderId: SandboxProviderId;
  agentType: AgentType | null;
  explicitTitle: string | null;
  explicitBranchName: string | null;
  initialPrompt: string | null;
}

interface InitializeCommand {
  sandboxProviderId?: SandboxProviderId;
}

interface TaskActionCommand {
  reason?: string;
}

interface TaskSessionCommand {
  sessionId: string;
}

interface TaskStatusSyncCommand {
  sessionId: string;
  status: "running" | "idle" | "error";
  at: number;
}

interface TaskWorkbenchValueCommand {
  value: string;
}

interface TaskWorkbenchSessionTitleCommand {
  sessionId: string;
  title: string;
}

interface TaskWorkbenchSessionUnreadCommand {
  sessionId: string;
  unread: boolean;
}

interface TaskWorkbenchUpdateDraftCommand {
  sessionId: string;
  text: string;
  attachments: Array<any>;
}

interface TaskWorkbenchChangeModelCommand {
  sessionId: string;
  model: string;
}

interface TaskWorkbenchSendMessageCommand {
  sessionId: string;
  text: string;
  attachments: Array<any>;
}

interface TaskWorkbenchCreateSessionCommand {
  model?: string;
}

interface TaskWorkbenchCreateSessionAndSendCommand {
  model?: string;
  text: string;
}

interface TaskWorkbenchSessionCommand {
  sessionId: string;
}

export const task = actor({
  db: taskDb,
  queues: Object.fromEntries(TASK_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    name: "Task",
    icon: "wrench",
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, input: TaskInput) => ({
    organizationId: input.organizationId,
    repoId: input.repoId,
    taskId: input.taskId,
    repoRemote: input.repoRemote,
    branchName: input.branchName,
    title: input.title,
    task: input.task,
    sandboxProviderId: input.sandboxProviderId,
    agentType: input.agentType,
    explicitTitle: input.explicitTitle,
    explicitBranchName: input.explicitBranchName,
    initialPrompt: input.initialPrompt,
    initialized: false,
    previousStatus: null as string | null,
  }),
  actions: {
    async initialize(c, cmd: InitializeCommand): Promise<TaskRecord> {
      const self = selfTask(c);
      const result = await self.send(taskWorkflowQueueName("task.command.initialize"), cmd ?? {}, {
        wait: true,
        timeout: 10_000,
      });
      return expectQueueResponse<TaskRecord>(result);
    },

    async provision(c, cmd: InitializeCommand): Promise<{ ok: true }> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.provision"), cmd ?? {}, {
        wait: false,
      });
      return { ok: true };
    },

    async attach(c, cmd?: TaskActionCommand): Promise<{ target: string; sessionId: string | null }> {
      const self = selfTask(c);
      const result = await self.send(taskWorkflowQueueName("task.command.attach"), cmd ?? {}, {
        wait: true,
        timeout: 10_000,
      });
      return expectQueueResponse<{ target: string; sessionId: string | null }>(result);
    },

    async switch(c): Promise<{ switchTarget: string }> {
      const self = selfTask(c);
      const result = await self.send(
        taskWorkflowQueueName("task.command.switch"),
        {},
        {
          wait: true,
          timeout: 10_000,
        },
      );
      return expectQueueResponse<{ switchTarget: string }>(result);
    },

    async push(c, cmd?: TaskActionCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.push"), cmd ?? {}, {
        wait: false,
      });
    },

    async sync(c, cmd?: TaskActionCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.sync"), cmd ?? {}, {
        wait: false,
      });
    },

    async merge(c, cmd?: TaskActionCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.merge"), cmd ?? {}, {
        wait: false,
      });
    },

    async archive(c, cmd?: TaskActionCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.archive"), cmd ?? {}, {
        wait: false,
      });
    },

    async kill(c, cmd?: TaskActionCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.kill"), cmd ?? {}, {
        wait: false,
      });
    },

    async get(c): Promise<TaskRecord> {
      return await getCurrentRecord({ db: c.db, state: c.state });
    },

    async getTaskSummary(c) {
      return await getTaskSummary(c);
    },

    async getTaskDetail(c) {
      return await getTaskDetail(c);
    },

    async getSessionDetail(c, input: { sessionId: string }) {
      return await getSessionDetail(c, input.sessionId);
    },

    async markWorkbenchUnread(c): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.mark_unread"),
        {},
        {
          wait: true,
          timeout: 10_000,
        },
      );
    },

    async renameWorkbenchTask(c, input: TaskWorkbenchRenameInput): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.workbench.rename_task"), { value: input.value } satisfies TaskWorkbenchValueCommand, {
        wait: true,
        timeout: 20_000,
      });
    },

    async renameWorkbenchBranch(c, input: TaskWorkbenchRenameInput): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.workbench.rename_branch"), { value: input.value } satisfies TaskWorkbenchValueCommand, {
        wait: false,
      });
    },

    async createWorkbenchSession(c, input?: { model?: string }): Promise<{ sessionId: string }> {
      const self = selfTask(c);
      const result = await self.send(
        taskWorkflowQueueName("task.command.workbench.create_session"),
        { ...(input?.model ? { model: input.model } : {}) } satisfies TaskWorkbenchCreateSessionCommand,
        {
          wait: true,
          timeout: 10_000,
        },
      );
      return expectQueueResponse<{ sessionId: string }>(result);
    },

    /**
     * Fire-and-forget: creates a workbench session and sends the initial message.
     * Used by createWorkbenchTask so the caller doesn't block on session creation.
     */
    async createWorkbenchSessionAndSend(c, input: { model?: string; text: string }): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.create_session_and_send"),
        { model: input.model, text: input.text } satisfies TaskWorkbenchCreateSessionAndSendCommand,
        { wait: false },
      );
    },

    async renameWorkbenchSession(c, input: TaskWorkbenchRenameSessionInput): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.rename_session"),
        { sessionId: input.sessionId, title: input.title } satisfies TaskWorkbenchSessionTitleCommand,
        {
          wait: true,
          timeout: 10_000,
        },
      );
    },

    async setWorkbenchSessionUnread(c, input: TaskWorkbenchSetSessionUnreadInput): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.set_session_unread"),
        { sessionId: input.sessionId, unread: input.unread } satisfies TaskWorkbenchSessionUnreadCommand,
        {
          wait: true,
          timeout: 10_000,
        },
      );
    },

    async updateWorkbenchDraft(c, input: TaskWorkbenchUpdateDraftInput): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.update_draft"),
        {
          sessionId: input.sessionId,
          text: input.text,
          attachments: input.attachments,
        } satisfies TaskWorkbenchUpdateDraftCommand,
        {
          wait: false,
        },
      );
    },

    async changeWorkbenchModel(c, input: TaskWorkbenchChangeModelInput): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.change_model"),
        { sessionId: input.sessionId, model: input.model } satisfies TaskWorkbenchChangeModelCommand,
        {
          wait: true,
          timeout: 10_000,
        },
      );
    },

    async sendWorkbenchMessage(c, input: TaskWorkbenchSendMessageInput): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.send_message"),
        {
          sessionId: input.sessionId,
          text: input.text,
          attachments: input.attachments,
        } satisfies TaskWorkbenchSendMessageCommand,
        {
          wait: false,
        },
      );
    },

    async stopWorkbenchSession(c, input: TaskSessionCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.workbench.stop_session"), { sessionId: input.sessionId } satisfies TaskWorkbenchSessionCommand, {
        wait: false,
      });
    },

    async syncWorkbenchSessionStatus(c, input: TaskStatusSyncCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.workbench.sync_session_status"), input, {
        wait: true,
        timeout: 20_000,
      });
    },

    async closeWorkbenchSession(c, input: TaskSessionCommand): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.workbench.close_session"), { sessionId: input.sessionId } satisfies TaskWorkbenchSessionCommand, {
        wait: false,
      });
    },

    async publishWorkbenchPr(c): Promise<void> {
      const self = selfTask(c);
      await self.send(
        taskWorkflowQueueName("task.command.workbench.publish_pr"),
        {},
        {
          wait: false,
        },
      );
    },

    async revertWorkbenchFile(c, input: { path: string }): Promise<void> {
      const self = selfTask(c);
      await self.send(taskWorkflowQueueName("task.command.workbench.revert_file"), input, {
        wait: false,
      });
    },
  },
  run: workflow(runTaskWorkflow),
});

export { TASK_QUEUE_NAMES };
