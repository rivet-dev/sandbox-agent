// @ts-nocheck
import { eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../../context.js";
import { getOrCreateTaskStatusSync } from "../../handles.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { task as taskTable, taskRuntime } from "../db/schema.js";
import { TASK_ROW_ID, appendHistory, getCurrentRecord, setTaskState } from "./common.js";
import { pushActiveBranchActivity } from "./push.js";

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function handleAttachActivity(loopCtx: any, msg: any): Promise<void> {
  const record = await getCurrentRecord(loopCtx);
  const { providers } = getActorRuntimeContext();
  const activeSandbox = record.activeSandboxId ? (record.sandboxes.find((sb: any) => sb.sandboxId === record.activeSandboxId) ?? null) : null;
  const provider = providers.get(activeSandbox?.providerId ?? record.providerId);
  const target = await provider.attachTarget({
    workspaceId: loopCtx.state.workspaceId,
    sandboxId: record.activeSandboxId ?? "",
  });

  await appendHistory(loopCtx, "task.attach", {
    target: target.target,
    sessionId: record.activeSessionId,
  });

  await msg.complete({
    target: target.target,
    sessionId: record.activeSessionId,
  });
}

export async function handleSwitchActivity(loopCtx: any, msg: any): Promise<void> {
  const db = loopCtx.db;
  const runtime = await db.select({ switchTarget: taskRuntime.activeSwitchTarget }).from(taskRuntime).where(eq(taskRuntime.id, TASK_ROW_ID)).get();

  await msg.complete({ switchTarget: runtime?.switchTarget ?? "" });
}

export async function handlePushActivity(loopCtx: any, msg: any): Promise<void> {
  await pushActiveBranchActivity(loopCtx, {
    reason: msg.body?.reason ?? null,
    historyKind: "task.push",
  });
  await msg.complete({ ok: true });
}

export async function handleSimpleCommandActivity(loopCtx: any, msg: any, statusMessage: string, historyKind: string): Promise<void> {
  const db = loopCtx.db;
  await db.update(taskRuntime).set({ statusMessage, updatedAt: Date.now() }).where(eq(taskRuntime.id, TASK_ROW_ID)).run();

  await appendHistory(loopCtx, historyKind, { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function handleArchiveActivity(loopCtx: any, msg: any): Promise<void> {
  await setTaskState(loopCtx, "archive_stop_status_sync", "stopping status sync");
  const record = await getCurrentRecord(loopCtx);

  if (record.activeSandboxId && record.activeSessionId) {
    try {
      const sync = await getOrCreateTaskStatusSync(
        loopCtx,
        loopCtx.state.workspaceId,
        loopCtx.state.repoId,
        loopCtx.state.taskId,
        record.activeSandboxId,
        record.activeSessionId,
        {
          workspaceId: loopCtx.state.workspaceId,
          repoId: loopCtx.state.repoId,
          taskId: loopCtx.state.taskId,
          providerId: record.providerId,
          sandboxId: record.activeSandboxId,
          sessionId: record.activeSessionId,
          intervalMs: 2_000,
        },
      );
      await withTimeout(sync.stop(), 15_000, "task status sync stop");
    } catch (error) {
      logActorWarning("task.commands", "failed to stop status sync during archive", {
        workspaceId: loopCtx.state.workspaceId,
        repoId: loopCtx.state.repoId,
        taskId: loopCtx.state.taskId,
        sandboxId: record.activeSandboxId,
        sessionId: record.activeSessionId,
        error: resolveErrorMessage(error),
      });
    }
  }

  if (record.activeSandboxId) {
    await setTaskState(loopCtx, "archive_release_sandbox", "releasing sandbox");
    const { providers } = getActorRuntimeContext();
    const activeSandbox = record.sandboxes.find((sb: any) => sb.sandboxId === record.activeSandboxId) ?? null;
    const provider = providers.get(activeSandbox?.providerId ?? record.providerId);
    const workspaceId = loopCtx.state.workspaceId;
    const repoId = loopCtx.state.repoId;
    const taskId = loopCtx.state.taskId;
    const sandboxId = record.activeSandboxId;

    // Do not block archive finalization on provider stop. Some provider stop calls can
    // run longer than the synchronous archive UX budget.
    void withTimeout(
      provider.releaseSandbox({
        workspaceId,
        sandboxId,
      }),
      45_000,
      "provider releaseSandbox",
    ).catch((error) => {
      logActorWarning("task.commands", "failed to release sandbox during archive", {
        workspaceId,
        repoId,
        taskId,
        sandboxId,
        error: resolveErrorMessage(error),
      });
    });
  }

  const db = loopCtx.db;
  await setTaskState(loopCtx, "archive_finalize", "finalizing archive");
  await db.update(taskTable).set({ status: "archived", updatedAt: Date.now() }).where(eq(taskTable.id, TASK_ROW_ID)).run();

  await db.update(taskRuntime).set({ activeSessionId: null, statusMessage: "archived", updatedAt: Date.now() }).where(eq(taskRuntime.id, TASK_ROW_ID)).run();

  await appendHistory(loopCtx, "task.archive", { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function killDestroySandboxActivity(loopCtx: any): Promise<void> {
  await setTaskState(loopCtx, "kill_destroy_sandbox", "destroying sandbox");
  const record = await getCurrentRecord(loopCtx);
  if (!record.activeSandboxId) {
    return;
  }

  const { providers } = getActorRuntimeContext();
  const activeSandbox = record.sandboxes.find((sb: any) => sb.sandboxId === record.activeSandboxId) ?? null;
  const provider = providers.get(activeSandbox?.providerId ?? record.providerId);
  await provider.destroySandbox({
    workspaceId: loopCtx.state.workspaceId,
    sandboxId: record.activeSandboxId,
  });
}

export async function killWriteDbActivity(loopCtx: any, msg: any): Promise<void> {
  await setTaskState(loopCtx, "kill_finalize", "finalizing kill");
  const db = loopCtx.db;
  await db.update(taskTable).set({ status: "killed", updatedAt: Date.now() }).where(eq(taskTable.id, TASK_ROW_ID)).run();

  await db.update(taskRuntime).set({ statusMessage: "killed", updatedAt: Date.now() }).where(eq(taskRuntime.id, TASK_ROW_ID)).run();

  await appendHistory(loopCtx, "task.kill", { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function handleGetActivity(loopCtx: any, msg: any): Promise<void> {
  await msg.complete(await getCurrentRecord(loopCtx));
}
