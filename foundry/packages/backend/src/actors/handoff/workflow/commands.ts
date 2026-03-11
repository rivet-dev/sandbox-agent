// @ts-nocheck
import { eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../../context.js";
import { getOrCreateHandoffStatusSync } from "../../handles.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { handoff as handoffTable, handoffRuntime } from "../db/schema.js";
import { HANDOFF_ROW_ID, appendHistory, getCurrentRecord, setHandoffState } from "./common.js";
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

  await appendHistory(loopCtx, "handoff.attach", {
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
  const runtime = await db.select({ switchTarget: handoffRuntime.activeSwitchTarget }).from(handoffRuntime).where(eq(handoffRuntime.id, HANDOFF_ROW_ID)).get();

  await msg.complete({ switchTarget: runtime?.switchTarget ?? "" });
}

export async function handlePushActivity(loopCtx: any, msg: any): Promise<void> {
  await pushActiveBranchActivity(loopCtx, {
    reason: msg.body?.reason ?? null,
    historyKind: "handoff.push",
  });
  await msg.complete({ ok: true });
}

export async function handleSimpleCommandActivity(loopCtx: any, msg: any, statusMessage: string, historyKind: string): Promise<void> {
  const db = loopCtx.db;
  await db.update(handoffRuntime).set({ statusMessage, updatedAt: Date.now() }).where(eq(handoffRuntime.id, HANDOFF_ROW_ID)).run();

  await appendHistory(loopCtx, historyKind, { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function handleArchiveActivity(loopCtx: any, msg: any): Promise<void> {
  await setHandoffState(loopCtx, "archive_stop_status_sync", "stopping status sync");
  const record = await getCurrentRecord(loopCtx);

  if (record.activeSandboxId && record.activeSessionId) {
    try {
      const sync = await getOrCreateHandoffStatusSync(
        loopCtx,
        loopCtx.state.workspaceId,
        loopCtx.state.repoId,
        loopCtx.state.handoffId,
        record.activeSandboxId,
        record.activeSessionId,
        {
          workspaceId: loopCtx.state.workspaceId,
          repoId: loopCtx.state.repoId,
          handoffId: loopCtx.state.handoffId,
          providerId: record.providerId,
          sandboxId: record.activeSandboxId,
          sessionId: record.activeSessionId,
          intervalMs: 2_000,
        },
      );
      await withTimeout(sync.stop(), 15_000, "handoff status sync stop");
    } catch (error) {
      logActorWarning("handoff.commands", "failed to stop status sync during archive", {
        workspaceId: loopCtx.state.workspaceId,
        repoId: loopCtx.state.repoId,
        handoffId: loopCtx.state.handoffId,
        sandboxId: record.activeSandboxId,
        sessionId: record.activeSessionId,
        error: resolveErrorMessage(error),
      });
    }
  }

  if (record.activeSandboxId) {
    await setHandoffState(loopCtx, "archive_release_sandbox", "releasing sandbox");
    const { providers } = getActorRuntimeContext();
    const activeSandbox = record.sandboxes.find((sb: any) => sb.sandboxId === record.activeSandboxId) ?? null;
    const provider = providers.get(activeSandbox?.providerId ?? record.providerId);
    const workspaceId = loopCtx.state.workspaceId;
    const repoId = loopCtx.state.repoId;
    const handoffId = loopCtx.state.handoffId;
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
      logActorWarning("handoff.commands", "failed to release sandbox during archive", {
        workspaceId,
        repoId,
        handoffId,
        sandboxId,
        error: resolveErrorMessage(error),
      });
    });
  }

  const db = loopCtx.db;
  await setHandoffState(loopCtx, "archive_finalize", "finalizing archive");
  await db.update(handoffTable).set({ status: "archived", updatedAt: Date.now() }).where(eq(handoffTable.id, HANDOFF_ROW_ID)).run();

  await db
    .update(handoffRuntime)
    .set({ activeSessionId: null, statusMessage: "archived", updatedAt: Date.now() })
    .where(eq(handoffRuntime.id, HANDOFF_ROW_ID))
    .run();

  await appendHistory(loopCtx, "handoff.archive", { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function killDestroySandboxActivity(loopCtx: any): Promise<void> {
  await setHandoffState(loopCtx, "kill_destroy_sandbox", "destroying sandbox");
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
  await setHandoffState(loopCtx, "kill_finalize", "finalizing kill");
  const db = loopCtx.db;
  await db.update(handoffTable).set({ status: "killed", updatedAt: Date.now() }).where(eq(handoffTable.id, HANDOFF_ROW_ID)).run();

  await db.update(handoffRuntime).set({ statusMessage: "killed", updatedAt: Date.now() }).where(eq(handoffRuntime.id, HANDOFF_ROW_ID)).run();

  await appendHistory(loopCtx, "handoff.kill", { reason: msg.body?.reason ?? null });
  await msg.complete({ ok: true });
}

export async function handleGetActivity(loopCtx: any, msg: any): Promise<void> {
  await msg.complete(await getCurrentRecord(loopCtx));
}
