// @ts-nocheck
import { eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../../context.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { task as taskTable, taskRuntime, taskSandboxes } from "../db/schema.js";
import { TASK_ROW_ID, appendHistory, resolveErrorDetail } from "./common.js";
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
      activeSandboxId: taskRuntime.activeSandboxId,
      activeSessionId: taskRuntime.activeSessionId,
    })
    .from(taskRuntime)
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .get();

  const isActive = runtime?.activeSandboxId === body.sandboxId && runtime?.activeSessionId === body.sessionId;

  if (isActive) {
    await db.update(taskTable).set({ status: newStatus, updatedAt: body.at }).where(eq(taskTable.id, TASK_ROW_ID)).run();

    await db
      .update(taskRuntime)
      .set({ statusMessage: `session:${body.status}`, updatedAt: body.at })
      .where(eq(taskRuntime.id, TASK_ROW_ID))
      .run();
  }

  await db
    .update(taskSandboxes)
    .set({ statusMessage: `session:${body.status}`, updatedAt: body.at })
    .where(eq(taskSandboxes.sandboxId, body.sandboxId))
    .run();

  await appendHistory(loopCtx, "task.status", {
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

  const self = await db.select({ prSubmitted: taskTable.prSubmitted }).from(taskTable).where(eq(taskTable.id, TASK_ROW_ID)).get();

  if (self && self.prSubmitted) return;

  try {
    await driver.git.fetch(loopCtx.state.repoLocalPath);
  } catch (error) {
    logActorWarning("task.status-sync", "fetch before PR submit failed", {
      workspaceId: loopCtx.state.workspaceId,
      repoId: loopCtx.state.repoId,
      taskId: loopCtx.state.taskId,
      error: resolveErrorMessage(error),
    });
  }

  if (!loopCtx.state.branchName || !loopCtx.state.title) {
    throw new Error("cannot submit PR before task has a branch and title");
  }

  try {
    await pushActiveBranchActivity(loopCtx, {
      reason: "auto_submit_idle",
      historyKind: "task.push.auto",
    });

    const pr = await driver.github.createPr(loopCtx.state.repoLocalPath, loopCtx.state.branchName, loopCtx.state.title);

    await db.update(taskTable).set({ prSubmitted: 1, updatedAt: Date.now() }).where(eq(taskTable.id, TASK_ROW_ID)).run();

    await appendHistory(loopCtx, "task.step", {
      step: "pr_submit",
      taskId: loopCtx.state.taskId,
      branchName: loopCtx.state.branchName,
      prUrl: pr.url,
      prNumber: pr.number,
    });

    await appendHistory(loopCtx, "task.pr_created", {
      taskId: loopCtx.state.taskId,
      branchName: loopCtx.state.branchName,
      prUrl: pr.url,
      prNumber: pr.number,
    });
  } catch (error) {
    const detail = resolveErrorDetail(error);
    await db
      .update(taskRuntime)
      .set({
        statusMessage: `pr submit failed: ${detail}`,
        updatedAt: Date.now(),
      })
      .where(eq(taskRuntime.id, TASK_ROW_ID))
      .run();

    await appendHistory(loopCtx, "task.pr_create_failed", {
      taskId: loopCtx.state.taskId,
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
