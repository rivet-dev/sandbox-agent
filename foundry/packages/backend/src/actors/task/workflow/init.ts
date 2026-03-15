// @ts-nocheck
import { eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../../context.js";
import { getOrCreateHistory, selfTask } from "../../handles.js";
import { resolveErrorMessage } from "../../logging.js";
import { defaultSandboxProviderId } from "../../../sandbox-config.js";
import { task as taskTable, taskRuntime } from "../db/schema.js";
import { TASK_ROW_ID, appendHistory, collectErrorMessages, resolveErrorDetail, setTaskState } from "./common.js";
import { taskWorkflowQueueName } from "./queue.js";

async function ensureTaskRuntimeCacheColumns(db: any): Promise<void> {
  await db.execute(`ALTER TABLE task_runtime ADD COLUMN git_state_json text`).catch(() => {});
  await db.execute(`ALTER TABLE task_runtime ADD COLUMN git_state_updated_at integer`).catch(() => {});
  await db.execute(`ALTER TABLE task_runtime ADD COLUMN provision_stage text`).catch(() => {});
  await db.execute(`ALTER TABLE task_runtime ADD COLUMN provision_stage_updated_at integer`).catch(() => {});
}

export async function initBootstrapDbActivity(loopCtx: any, body: any): Promise<void> {
  const { config } = getActorRuntimeContext();
  const sandboxProviderId = body?.sandboxProviderId ?? loopCtx.state.sandboxProviderId ?? defaultSandboxProviderId(config);
  const now = Date.now();

  await ensureTaskRuntimeCacheColumns(loopCtx.db);

  await loopCtx.db
    .insert(taskTable)
    .values({
      id: TASK_ROW_ID,
      branchName: loopCtx.state.branchName,
      title: loopCtx.state.title,
      task: loopCtx.state.task,
      sandboxProviderId,
      status: "init_bootstrap_db",
      agentType: loopCtx.state.agentType ?? config.default_agent,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskTable.id,
      set: {
        branchName: loopCtx.state.branchName,
        title: loopCtx.state.title,
        task: loopCtx.state.task,
        sandboxProviderId,
        status: "init_bootstrap_db",
        agentType: loopCtx.state.agentType ?? config.default_agent,
        updatedAt: now,
      },
    })
    .run();

  await loopCtx.db
    .insert(taskRuntime)
    .values({
      id: TASK_ROW_ID,
      activeSandboxId: null,
      activeSessionId: null,
      activeSwitchTarget: null,
      activeCwd: null,
      statusMessage: "provisioning",
      gitStateJson: null,
      gitStateUpdatedAt: null,
      provisionStage: "queued",
      provisionStageUpdatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskRuntime.id,
      set: {
        activeSandboxId: null,
        activeSessionId: null,
        activeSwitchTarget: null,
        activeCwd: null,
        statusMessage: "provisioning",
        provisionStage: "queued",
        provisionStageUpdatedAt: now,
        updatedAt: now,
      },
    })
    .run();
}

export async function initEnqueueProvisionActivity(loopCtx: any, body: any): Promise<void> {
  await setTaskState(loopCtx, "init_enqueue_provision", "provision queued");
  await loopCtx.db
    .update(taskRuntime)
    .set({
      provisionStage: "queued",
      provisionStageUpdatedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .run();

  const self = selfTask(loopCtx);
  try {
    await self.send(taskWorkflowQueueName("task.command.provision"), body, {
      wait: false,
    });
  } catch (error) {
    logActorWarning("task.init", "background provision command failed", {
      organizationId: loopCtx.state.organizationId,
      repoId: loopCtx.state.repoId,
      taskId: loopCtx.state.taskId,
      error: resolveErrorMessage(error),
    });
    throw error;
  }
}

export async function initCompleteActivity(loopCtx: any, body: any): Promise<void> {
  const now = Date.now();
  const { config } = getActorRuntimeContext();
  const sandboxProviderId = body?.sandboxProviderId ?? loopCtx.state.sandboxProviderId ?? defaultSandboxProviderId(config);

  await setTaskState(loopCtx, "init_complete", "task initialized");
  await loopCtx.db
    .update(taskRuntime)
    .set({
      statusMessage: "ready",
      provisionStage: "ready",
      provisionStageUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .run();

  const history = await getOrCreateHistory(loopCtx, loopCtx.state.organizationId, loopCtx.state.repoId);
  await history.append({
    kind: "task.initialized",
    taskId: loopCtx.state.taskId,
    branchName: loopCtx.state.branchName,
    payload: { sandboxProviderId },
  });

  loopCtx.state.initialized = true;
}

export async function initFailedActivity(loopCtx: any, error: unknown): Promise<void> {
  const now = Date.now();
  const detail = resolveErrorDetail(error);
  const messages = collectErrorMessages(error);
  const { config } = getActorRuntimeContext();
  const sandboxProviderId = loopCtx.state.sandboxProviderId ?? defaultSandboxProviderId(config);

  await loopCtx.db
    .insert(taskTable)
    .values({
      id: TASK_ROW_ID,
      branchName: loopCtx.state.branchName ?? null,
      title: loopCtx.state.title ?? null,
      task: loopCtx.state.task,
      sandboxProviderId,
      status: "error",
      agentType: loopCtx.state.agentType ?? config.default_agent,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskTable.id,
      set: {
        branchName: loopCtx.state.branchName ?? null,
        title: loopCtx.state.title ?? null,
        task: loopCtx.state.task,
        sandboxProviderId,
        status: "error",
        agentType: loopCtx.state.agentType ?? config.default_agent,
        updatedAt: now,
      },
    })
    .run();

  await loopCtx.db
    .insert(taskRuntime)
    .values({
      id: TASK_ROW_ID,
      activeSandboxId: null,
      activeSessionId: null,
      activeSwitchTarget: null,
      activeCwd: null,
      statusMessage: detail,
      provisionStage: "error",
      provisionStageUpdatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskRuntime.id,
      set: {
        activeSandboxId: null,
        activeSessionId: null,
        activeSwitchTarget: null,
        activeCwd: null,
        statusMessage: detail,
        provisionStage: "error",
        provisionStageUpdatedAt: now,
        updatedAt: now,
      },
    })
    .run();

  await appendHistory(loopCtx, "task.error", {
    detail,
    messages,
  });
}
