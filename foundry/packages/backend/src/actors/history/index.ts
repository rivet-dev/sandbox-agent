// @ts-nocheck
import { and, desc, eq } from "drizzle-orm";
import { actor, queue } from "rivetkit";
import { Loop, workflow } from "rivetkit/workflow";
import type { HistoryEvent } from "@sandbox-agent/foundry-shared";
import { selfHistory } from "../handles.js";
import { historyDb } from "./db/db.js";
import { events } from "./db/schema.js";

export interface HistoryInput {
  organizationId: string;
  repoId: string;
}

export interface AppendHistoryCommand {
  kind: string;
  taskId?: string;
  branchName?: string;
  payload: Record<string, unknown>;
}

export interface ListHistoryParams {
  branch?: string;
  taskId?: string;
  limit?: number;
}

const HISTORY_QUEUE_NAMES = ["history.command.append"] as const;

async function appendHistoryRow(loopCtx: any, body: AppendHistoryCommand): Promise<void> {
  const now = Date.now();
  await loopCtx.db
    .insert(events)
    .values({
      taskId: body.taskId ?? null,
      branchName: body.branchName ?? null,
      kind: body.kind,
      payloadJson: JSON.stringify(body.payload),
      createdAt: now,
    })
    .run();
}

async function runHistoryWorkflow(ctx: any): Promise<void> {
  await ctx.loop("history-command-loop", async (loopCtx: any) => {
    const msg = await loopCtx.queue.next("next-history-command", {
      names: [...HISTORY_QUEUE_NAMES],
      completable: true,
    });
    if (!msg) {
      return Loop.continue(undefined);
    }

    if (msg.name === "history.command.append") {
      await loopCtx.step("append-history-row", async () => appendHistoryRow(loopCtx, msg.body as AppendHistoryCommand));
      await msg.complete({ ok: true });
    }

    return Loop.continue(undefined);
  });
}

export const history = actor({
  db: historyDb,
  queues: {
    "history.command.append": queue(),
  },
  options: {
    name: "History",
    icon: "database",
  },
  createState: (_c, input: HistoryInput) => ({
    organizationId: input.organizationId,
    repoId: input.repoId,
  }),
  actions: {
    async append(c, command: AppendHistoryCommand): Promise<void> {
      const self = selfHistory(c);
      await self.send("history.command.append", command, { wait: true, timeout: 15_000 });
    },

    async list(c, params?: ListHistoryParams): Promise<HistoryEvent[]> {
      const whereParts = [];
      if (params?.taskId) {
        whereParts.push(eq(events.taskId, params.taskId));
      }
      if (params?.branch) {
        whereParts.push(eq(events.branchName, params.branch));
      }

      const base = c.db
        .select({
          id: events.id,
          taskId: events.taskId,
          branchName: events.branchName,
          kind: events.kind,
          payloadJson: events.payloadJson,
          createdAt: events.createdAt,
        })
        .from(events);

      const rows = await (whereParts.length > 0 ? base.where(and(...whereParts)) : base)
        .orderBy(desc(events.createdAt))
        .limit(params?.limit ?? 100)
        .all();

      return rows.map((row) => ({
        ...row,
        organizationId: c.state.organizationId,
        repoId: c.state.repoId,
      }));
    },
  },
  run: workflow(runHistoryWorkflow),
});
