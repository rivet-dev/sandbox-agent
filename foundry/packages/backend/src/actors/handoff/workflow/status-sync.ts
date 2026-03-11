// @ts-nocheck
import { eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../../context.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { handoff as handoffTable, handoffRuntime, handoffSandboxes } from "../db/schema.js";
import { HANDOFF_ROW_ID, appendHistory, resolveErrorDetail } from "./common.js";
import { pushActiveBranchActivity } from "./push.js";

function mapSessionStatus(status: "running" | "idle" | "error") {
  if (status === "idle") return "idle";
  if (status === "error") return "error";
  return "running";
}

export async function statusUpdateActivity(loopCtx: any, body: any): Promise<boolean> {
  const newStatus = mapSessionStatus(body.status);
  const wasIdle = loopCtx.state.previousStatus === "idle";
  const didTransition = newStatus === "idle" && !wasIdle;
  const isDuplicateStatus = loopCtx.state.previousStatus === newStatus;

  if (isDuplicateStatus) {
    return false;
  }

  const db = loopCtx.db;
  const runtime = await db
    .select({
      activeSandboxId: handoffRuntime.activeSandboxId,
      activeSessionId: handoffRuntime.activeSessionId,
    })
    .from(handoffRuntime)
    .where(eq(handoffRuntime.id, HANDOFF_ROW_ID))
    .get();

  const isActive = runtime?.activeSandboxId === body.sandboxId && runtime?.activeSessionId === body.sessionId;

  if (isActive) {
    await db.update(handoffTable).set({ status: newStatus, updatedAt: body.at }).where(eq(handoffTable.id, HANDOFF_ROW_ID)).run();

    await db
      .update(handoffRuntime)
      .set({ statusMessage: `session:${body.status}`, updatedAt: body.at })
      .where(eq(handoffRuntime.id, HANDOFF_ROW_ID))
      .run();
  }

  await db
    .update(handoffSandboxes)
    .set({ statusMessage: `session:${body.status}`, updatedAt: body.at })
    .where(eq(handoffSandboxes.sandboxId, body.sandboxId))
    .run();

  await appendHistory(loopCtx, "handoff.status", {
    status: body.status,
    sessionId: body.sessionId,
    sandboxId: body.sandboxId,
  });

  if (isActive) {
    loopCtx.state.previousStatus = newStatus;

    const { driver } = getActorRuntimeContext();
    if (loopCtx.state.branchName) {
      driver.tmux.setWindowStatus(loopCtx.state.branchName, newStatus);
    }
    return didTransition;
  }

  return false;
}

export async function idleSubmitPrActivity(loopCtx: any): Promise<void> {
  const { driver } = getActorRuntimeContext();
  const db = loopCtx.db;

  const self = await db.select({ prSubmitted: handoffTable.prSubmitted }).from(handoffTable).where(eq(handoffTable.id, HANDOFF_ROW_ID)).get();

  if (self && self.prSubmitted) return;

  try {
    await driver.git.fetch(loopCtx.state.repoLocalPath);
  } catch (error) {
    logActorWarning("handoff.status-sync", "fetch before PR submit failed", {
      workspaceId: loopCtx.state.workspaceId,
      repoId: loopCtx.state.repoId,
      handoffId: loopCtx.state.handoffId,
      error: resolveErrorMessage(error),
    });
  }

  if (!loopCtx.state.branchName || !loopCtx.state.title) {
    throw new Error("cannot submit PR before handoff has a branch and title");
  }

  try {
    await pushActiveBranchActivity(loopCtx, {
      reason: "auto_submit_idle",
      historyKind: "handoff.push.auto",
    });

    const pr = await driver.github.createPr(loopCtx.state.repoLocalPath, loopCtx.state.branchName, loopCtx.state.title);

    await db.update(handoffTable).set({ prSubmitted: 1, updatedAt: Date.now() }).where(eq(handoffTable.id, HANDOFF_ROW_ID)).run();

    await appendHistory(loopCtx, "handoff.step", {
      step: "pr_submit",
      handoffId: loopCtx.state.handoffId,
      branchName: loopCtx.state.branchName,
      prUrl: pr.url,
      prNumber: pr.number,
    });

    await appendHistory(loopCtx, "handoff.pr_created", {
      handoffId: loopCtx.state.handoffId,
      branchName: loopCtx.state.branchName,
      prUrl: pr.url,
      prNumber: pr.number,
    });
  } catch (error) {
    const detail = resolveErrorDetail(error);
    await db
      .update(handoffRuntime)
      .set({
        statusMessage: `pr submit failed: ${detail}`,
        updatedAt: Date.now(),
      })
      .where(eq(handoffRuntime.id, HANDOFF_ROW_ID))
      .run();

    await appendHistory(loopCtx, "handoff.pr_create_failed", {
      handoffId: loopCtx.state.handoffId,
      branchName: loopCtx.state.branchName,
      error: detail,
    });
  }
}

export async function idleNotifyActivity(loopCtx: any): Promise<void> {
  const { notifications } = getActorRuntimeContext();
  if (notifications && loopCtx.state.branchName) {
    await notifications.agentIdle(loopCtx.state.branchName);
  }
}
