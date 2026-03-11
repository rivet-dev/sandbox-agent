import { actor, queue } from "rivetkit";
import { workflow } from "rivetkit/workflow";
import type {
  AgentType,
  HandoffRecord,
  HandoffWorkbenchChangeModelInput,
  HandoffWorkbenchRenameInput,
  HandoffWorkbenchRenameSessionInput,
  HandoffWorkbenchSetSessionUnreadInput,
  HandoffWorkbenchSendMessageInput,
  HandoffWorkbenchUpdateDraftInput,
  ProviderId,
} from "@sandbox-agent/foundry-shared";
import { expectQueueResponse } from "../../services/queue.js";
import { selfHandoff } from "../handles.js";
import { handoffDb } from "./db/db.js";
import { getCurrentRecord } from "./workflow/common.js";
import {
  changeWorkbenchModel,
  closeWorkbenchSession,
  createWorkbenchSession,
  getWorkbenchHandoff,
  markWorkbenchUnread,
  publishWorkbenchPr,
  renameWorkbenchBranch,
  renameWorkbenchHandoff,
  renameWorkbenchSession,
  revertWorkbenchFile,
  sendWorkbenchMessage,
  syncWorkbenchSessionStatus,
  setWorkbenchSessionUnread,
  stopWorkbenchSession,
  updateWorkbenchDraft,
} from "./workbench.js";
import { HANDOFF_QUEUE_NAMES, handoffWorkflowQueueName, runHandoffWorkflow } from "./workflow/index.js";

export interface HandoffInput {
  workspaceId: string;
  repoId: string;
  handoffId: string;
  repoRemote: string;
  repoLocalPath: string;
  branchName: string | null;
  title: string | null;
  task: string;
  providerId: ProviderId;
  agentType: AgentType | null;
  explicitTitle: string | null;
  explicitBranchName: string | null;
  initialPrompt: string | null;
}

interface InitializeCommand {
  providerId?: ProviderId;
}

interface HandoffActionCommand {
  reason?: string;
}

interface HandoffTabCommand {
  tabId: string;
}

interface HandoffStatusSyncCommand {
  sessionId: string;
  status: "running" | "idle" | "error";
  at: number;
}

interface HandoffWorkbenchValueCommand {
  value: string;
}

interface HandoffWorkbenchSessionTitleCommand {
  sessionId: string;
  title: string;
}

interface HandoffWorkbenchSessionUnreadCommand {
  sessionId: string;
  unread: boolean;
}

interface HandoffWorkbenchUpdateDraftCommand {
  sessionId: string;
  text: string;
  attachments: Array<any>;
}

interface HandoffWorkbenchChangeModelCommand {
  sessionId: string;
  model: string;
}

interface HandoffWorkbenchSendMessageCommand {
  sessionId: string;
  text: string;
  attachments: Array<any>;
}

interface HandoffWorkbenchCreateSessionCommand {
  model?: string;
}

interface HandoffWorkbenchSessionCommand {
  sessionId: string;
}

export const handoff = actor({
  db: handoffDb,
  queues: Object.fromEntries(HANDOFF_QUEUE_NAMES.map((name) => [name, queue()])),
  options: {
    actionTimeout: 5 * 60_000,
  },
  createState: (_c, input: HandoffInput) => ({
    workspaceId: input.workspaceId,
    repoId: input.repoId,
    handoffId: input.handoffId,
    repoRemote: input.repoRemote,
    repoLocalPath: input.repoLocalPath,
    branchName: input.branchName,
    title: input.title,
    task: input.task,
    providerId: input.providerId,
    agentType: input.agentType,
    explicitTitle: input.explicitTitle,
    explicitBranchName: input.explicitBranchName,
    initialPrompt: input.initialPrompt,
    initialized: false,
    previousStatus: null as string | null,
  }),
  actions: {
    async initialize(c, cmd: InitializeCommand): Promise<HandoffRecord> {
      const self = selfHandoff(c);
      const result = await self.send(handoffWorkflowQueueName("handoff.command.initialize"), cmd ?? {}, {
        wait: true,
        timeout: 60_000,
      });
      return expectQueueResponse<HandoffRecord>(result);
    },

    async provision(c, cmd: InitializeCommand): Promise<{ ok: true }> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.provision"), cmd ?? {}, {
        wait: true,
        timeout: 30 * 60_000,
      });
      return { ok: true };
    },

    async attach(c, cmd?: HandoffActionCommand): Promise<{ target: string; sessionId: string | null }> {
      const self = selfHandoff(c);
      const result = await self.send(handoffWorkflowQueueName("handoff.command.attach"), cmd ?? {}, {
        wait: true,
        timeout: 20_000,
      });
      return expectQueueResponse<{ target: string; sessionId: string | null }>(result);
    },

    async switch(c): Promise<{ switchTarget: string }> {
      const self = selfHandoff(c);
      const result = await self.send(
        handoffWorkflowQueueName("handoff.command.switch"),
        {},
        {
          wait: true,
          timeout: 20_000,
        },
      );
      return expectQueueResponse<{ switchTarget: string }>(result);
    },

    async push(c, cmd?: HandoffActionCommand): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.push"), cmd ?? {}, {
        wait: true,
        timeout: 180_000,
      });
    },

    async sync(c, cmd?: HandoffActionCommand): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.sync"), cmd ?? {}, {
        wait: true,
        timeout: 30_000,
      });
    },

    async merge(c, cmd?: HandoffActionCommand): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.merge"), cmd ?? {}, {
        wait: true,
        timeout: 30_000,
      });
    },

    async archive(c, cmd?: HandoffActionCommand): Promise<void> {
      const self = selfHandoff(c);
      void self
        .send(handoffWorkflowQueueName("handoff.command.archive"), cmd ?? {}, {
          wait: true,
          timeout: 60_000,
        })
        .catch((error: unknown) => {
          c.log.warn({
            msg: "archive command failed",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },

    async kill(c, cmd?: HandoffActionCommand): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.kill"), cmd ?? {}, {
        wait: true,
        timeout: 60_000,
      });
    },

    async get(c): Promise<HandoffRecord> {
      return await getCurrentRecord({ db: c.db, state: c.state });
    },

    async getWorkbench(c) {
      return await getWorkbenchHandoff(c);
    },

    async markWorkbenchUnread(c): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.mark_unread"),
        {},
        {
          wait: true,
          timeout: 20_000,
        },
      );
    },

    async renameWorkbenchHandoff(c, input: HandoffWorkbenchRenameInput): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.workbench.rename_handoff"), { value: input.value } satisfies HandoffWorkbenchValueCommand, {
        wait: true,
        timeout: 20_000,
      });
    },

    async renameWorkbenchBranch(c, input: HandoffWorkbenchRenameInput): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.workbench.rename_branch"), { value: input.value } satisfies HandoffWorkbenchValueCommand, {
        wait: true,
        timeout: 5 * 60_000,
      });
    },

    async createWorkbenchSession(c, input?: { model?: string }): Promise<{ tabId: string }> {
      const self = selfHandoff(c);
      const result = await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.create_session"),
        { ...(input?.model ? { model: input.model } : {}) } satisfies HandoffWorkbenchCreateSessionCommand,
        {
          wait: true,
          timeout: 5 * 60_000,
        },
      );
      return expectQueueResponse<{ tabId: string }>(result);
    },

    async renameWorkbenchSession(c, input: HandoffWorkbenchRenameSessionInput): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.rename_session"),
        { sessionId: input.tabId, title: input.title } satisfies HandoffWorkbenchSessionTitleCommand,
        {
          wait: true,
          timeout: 20_000,
        },
      );
    },

    async setWorkbenchSessionUnread(c, input: HandoffWorkbenchSetSessionUnreadInput): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.set_session_unread"),
        { sessionId: input.tabId, unread: input.unread } satisfies HandoffWorkbenchSessionUnreadCommand,
        {
          wait: true,
          timeout: 20_000,
        },
      );
    },

    async updateWorkbenchDraft(c, input: HandoffWorkbenchUpdateDraftInput): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.update_draft"),
        {
          sessionId: input.tabId,
          text: input.text,
          attachments: input.attachments,
        } satisfies HandoffWorkbenchUpdateDraftCommand,
        {
          wait: true,
          timeout: 20_000,
        },
      );
    },

    async changeWorkbenchModel(c, input: HandoffWorkbenchChangeModelInput): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.change_model"),
        { sessionId: input.tabId, model: input.model } satisfies HandoffWorkbenchChangeModelCommand,
        {
          wait: true,
          timeout: 20_000,
        },
      );
    },

    async sendWorkbenchMessage(c, input: HandoffWorkbenchSendMessageInput): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.send_message"),
        {
          sessionId: input.tabId,
          text: input.text,
          attachments: input.attachments,
        } satisfies HandoffWorkbenchSendMessageCommand,
        {
          wait: true,
          timeout: 10 * 60_000,
        },
      );
    },

    async stopWorkbenchSession(c, input: HandoffTabCommand): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.workbench.stop_session"), { sessionId: input.tabId } satisfies HandoffWorkbenchSessionCommand, {
        wait: true,
        timeout: 5 * 60_000,
      });
    },

    async syncWorkbenchSessionStatus(c, input: HandoffStatusSyncCommand): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.workbench.sync_session_status"), input, {
        wait: true,
        timeout: 20_000,
      });
    },

    async closeWorkbenchSession(c, input: HandoffTabCommand): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.close_session"),
        { sessionId: input.tabId } satisfies HandoffWorkbenchSessionCommand,
        {
          wait: true,
          timeout: 5 * 60_000,
        },
      );
    },

    async publishWorkbenchPr(c): Promise<void> {
      const self = selfHandoff(c);
      await self.send(
        handoffWorkflowQueueName("handoff.command.workbench.publish_pr"),
        {},
        {
          wait: true,
          timeout: 10 * 60_000,
        },
      );
    },

    async revertWorkbenchFile(c, input: { path: string }): Promise<void> {
      const self = selfHandoff(c);
      await self.send(handoffWorkflowQueueName("handoff.command.workbench.revert_file"), input, {
        wait: true,
        timeout: 5 * 60_000,
      });
    },
  },
  run: workflow(runHandoffWorkflow),
});

export { HANDOFF_QUEUE_NAMES };
