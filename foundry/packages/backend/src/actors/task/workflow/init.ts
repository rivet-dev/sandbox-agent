// @ts-nocheck
import { desc, eq } from "drizzle-orm";
import { resolveCreateFlowDecision } from "../../../services/create-flow.js";
import { getActorRuntimeContext } from "../../context.js";
import { getOrCreateTaskStatusSync, getOrCreateHistory, getOrCreateProject, getOrCreateSandboxInstance, getSandboxInstance, selfTask } from "../../handles.js";
import { logActorWarning, resolveErrorMessage } from "../../logging.js";
import { task as taskTable, taskRuntime, taskSandboxes } from "../db/schema.js";
import { TASK_ROW_ID, appendHistory, buildAgentPrompt, collectErrorMessages, resolveErrorDetail, setTaskState } from "./common.js";
import { taskWorkflowQueueName } from "./queue.js";

const DEFAULT_INIT_CREATE_SANDBOX_ACTIVITY_TIMEOUT_MS = 180_000;

function getInitCreateSandboxActivityTimeoutMs(): number {
  const raw = process.env.HF_INIT_CREATE_SANDBOX_ACTIVITY_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_INIT_CREATE_SANDBOX_ACTIVITY_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INIT_CREATE_SANDBOX_ACTIVITY_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

function debugInit(loopCtx: any, message: string, context?: Record<string, unknown>): void {
  loopCtx.log.debug({
    msg: message,
    scope: "task.init",
    workspaceId: loopCtx.state.workspaceId,
    repoId: loopCtx.state.repoId,
    taskId: loopCtx.state.taskId,
    ...(context ?? {}),
  });
}

async function withActivityTimeout<T>(timeoutMs: number, label: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function initBootstrapDbActivity(loopCtx: any, body: any): Promise<void> {
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const { config } = getActorRuntimeContext();
  const now = Date.now();
  const db = loopCtx.db;
  const initialStatusMessage = loopCtx.state.branchName && loopCtx.state.title ? "provisioning" : "naming";

  try {
    await db
      .insert(taskTable)
      .values({
        id: TASK_ROW_ID,
        branchName: loopCtx.state.branchName,
        title: loopCtx.state.title,
        task: loopCtx.state.task,
        providerId,
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
          providerId,
          status: "init_bootstrap_db",
          agentType: loopCtx.state.agentType ?? config.default_agent,
          updatedAt: now,
        },
      })
      .run();

    await db
      .insert(taskRuntime)
      .values({
        id: TASK_ROW_ID,
        activeSandboxId: null,
        activeSessionId: null,
        activeSwitchTarget: null,
        activeCwd: null,
        statusMessage: initialStatusMessage,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: taskRuntime.id,
        set: {
          activeSandboxId: null,
          activeSessionId: null,
          activeSwitchTarget: null,
          activeCwd: null,
          statusMessage: initialStatusMessage,
          updatedAt: now,
        },
      })
      .run();
  } catch (error) {
    const detail = resolveErrorMessage(error);
    throw new Error(`task init bootstrap db failed: ${detail}`);
  }
}

export async function initEnqueueProvisionActivity(loopCtx: any, body: any): Promise<void> {
  await setTaskState(loopCtx, "init_enqueue_provision", "provision queued");
  const self = selfTask(loopCtx);
  void self
    .send(taskWorkflowQueueName("task.command.provision"), body, {
      wait: false,
    })
    .catch((error: unknown) => {
      logActorWarning("task.init", "background provision command failed", {
        workspaceId: loopCtx.state.workspaceId,
        repoId: loopCtx.state.repoId,
        taskId: loopCtx.state.taskId,
        error: resolveErrorMessage(error),
      });
    });
}

export async function initEnsureNameActivity(loopCtx: any): Promise<void> {
  await setTaskState(loopCtx, "init_ensure_name", "determining title and branch");
  const existing = await loopCtx.db
    .select({
      branchName: taskTable.branchName,
      title: taskTable.title,
    })
    .from(taskTable)
    .where(eq(taskTable.id, TASK_ROW_ID))
    .get();

  if (existing?.branchName && existing?.title) {
    loopCtx.state.branchName = existing.branchName;
    loopCtx.state.title = existing.title;
    return;
  }

  const { driver } = getActorRuntimeContext();
  try {
    await driver.git.fetch(loopCtx.state.repoLocalPath);
  } catch (error) {
    logActorWarning("task.init", "fetch before naming failed", {
      workspaceId: loopCtx.state.workspaceId,
      repoId: loopCtx.state.repoId,
      taskId: loopCtx.state.taskId,
      error: resolveErrorMessage(error),
    });
  }
  const remoteBranches = (await driver.git.listRemoteBranches(loopCtx.state.repoLocalPath)).map((branch: any) => branch.branchName);

  const project = await getOrCreateProject(loopCtx, loopCtx.state.workspaceId, loopCtx.state.repoId, loopCtx.state.repoRemote);
  const reservedBranches = await project.listReservedBranches({});

  const resolved = resolveCreateFlowDecision({
    task: loopCtx.state.task,
    explicitTitle: loopCtx.state.explicitTitle ?? undefined,
    explicitBranchName: loopCtx.state.explicitBranchName ?? undefined,
    localBranches: remoteBranches,
    taskBranches: reservedBranches,
  });

  const now = Date.now();
  await loopCtx.db
    .update(taskTable)
    .set({
      branchName: resolved.branchName,
      title: resolved.title,
      updatedAt: now,
    })
    .where(eq(taskTable.id, TASK_ROW_ID))
    .run();

  loopCtx.state.branchName = resolved.branchName;
  loopCtx.state.title = resolved.title;
  loopCtx.state.explicitTitle = null;
  loopCtx.state.explicitBranchName = null;

  await loopCtx.db
    .update(taskRuntime)
    .set({
      statusMessage: "provisioning",
      updatedAt: now,
    })
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .run();

  await project.registerTaskBranch({
    taskId: loopCtx.state.taskId,
    branchName: resolved.branchName,
  });

  await appendHistory(loopCtx, "task.named", {
    title: resolved.title,
    branchName: resolved.branchName,
  });
}

export async function initAssertNameActivity(loopCtx: any): Promise<void> {
  await setTaskState(loopCtx, "init_assert_name", "validating naming");
  if (!loopCtx.state.branchName) {
    throw new Error("task branchName is not initialized");
  }
}

export async function initCreateSandboxActivity(loopCtx: any, body: any): Promise<any> {
  await setTaskState(loopCtx, "init_create_sandbox", "creating sandbox");
  const { providers } = getActorRuntimeContext();
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const provider = providers.get(providerId);
  const timeoutMs = getInitCreateSandboxActivityTimeoutMs();
  const startedAt = Date.now();

  debugInit(loopCtx, "init_create_sandbox started", {
    providerId,
    timeoutMs,
    supportsSessionReuse: provider.capabilities().supportsSessionReuse,
  });

  if (provider.capabilities().supportsSessionReuse) {
    const runtime = await loopCtx.db.select({ activeSandboxId: taskRuntime.activeSandboxId }).from(taskRuntime).where(eq(taskRuntime.id, TASK_ROW_ID)).get();

    const existing = await loopCtx.db
      .select({ sandboxId: taskSandboxes.sandboxId })
      .from(taskSandboxes)
      .where(eq(taskSandboxes.providerId, providerId))
      .orderBy(desc(taskSandboxes.updatedAt))
      .limit(1)
      .get();

    const sandboxId = runtime?.activeSandboxId ?? existing?.sandboxId ?? null;
    if (sandboxId) {
      debugInit(loopCtx, "init_create_sandbox attempting resume", { sandboxId });
      try {
        const resumed = await withActivityTimeout(timeoutMs, "resumeSandbox", async () =>
          provider.resumeSandbox({
            workspaceId: loopCtx.state.workspaceId,
            sandboxId,
          }),
        );

        debugInit(loopCtx, "init_create_sandbox resume succeeded", {
          sandboxId: resumed.sandboxId,
          durationMs: Date.now() - startedAt,
        });
        return resumed;
      } catch (error) {
        logActorWarning("task.init", "resume sandbox failed; creating a new sandbox", {
          workspaceId: loopCtx.state.workspaceId,
          repoId: loopCtx.state.repoId,
          taskId: loopCtx.state.taskId,
          sandboxId,
          error: resolveErrorMessage(error),
        });
      }
    }
  }

  debugInit(loopCtx, "init_create_sandbox creating fresh sandbox", {
    branchName: loopCtx.state.branchName,
  });

  try {
    const sandbox = await withActivityTimeout(timeoutMs, "createSandbox", async () =>
      provider.createSandbox({
        workspaceId: loopCtx.state.workspaceId,
        repoId: loopCtx.state.repoId,
        repoRemote: loopCtx.state.repoRemote,
        branchName: loopCtx.state.branchName,
        taskId: loopCtx.state.taskId,
        debug: (message, context) => debugInit(loopCtx, message, context),
      }),
    );

    debugInit(loopCtx, "init_create_sandbox create succeeded", {
      sandboxId: sandbox.sandboxId,
      durationMs: Date.now() - startedAt,
    });
    return sandbox;
  } catch (error) {
    debugInit(loopCtx, "init_create_sandbox failed", {
      durationMs: Date.now() - startedAt,
      error: resolveErrorMessage(error),
    });
    throw error;
  }
}

export async function initEnsureAgentActivity(loopCtx: any, body: any, sandbox: any): Promise<any> {
  await setTaskState(loopCtx, "init_ensure_agent", "ensuring sandbox agent");
  const { providers } = getActorRuntimeContext();
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const provider = providers.get(providerId);
  return await provider.ensureSandboxAgent({
    workspaceId: loopCtx.state.workspaceId,
    sandboxId: sandbox.sandboxId,
  });
}

export async function initStartSandboxInstanceActivity(loopCtx: any, body: any, sandbox: any, agent: any): Promise<any> {
  await setTaskState(loopCtx, "init_start_sandbox_instance", "starting sandbox runtime");
  try {
    const providerId = body?.providerId ?? loopCtx.state.providerId;
    const sandboxInstance = await getOrCreateSandboxInstance(loopCtx, loopCtx.state.workspaceId, providerId, sandbox.sandboxId, {
      workspaceId: loopCtx.state.workspaceId,
      providerId,
      sandboxId: sandbox.sandboxId,
    });

    await sandboxInstance.ensure({
      metadata: sandbox.metadata,
      status: "ready",
      agentEndpoint: agent.endpoint,
      agentToken: agent.token,
    });

    const actorId = typeof (sandboxInstance as any).resolve === "function" ? await (sandboxInstance as any).resolve() : null;

    return {
      ok: true as const,
      actorId: typeof actorId === "string" ? actorId : null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false as const,
      error: `sandbox-instance ensure failed: ${detail}`,
    };
  }
}

export async function initCreateSessionActivity(loopCtx: any, body: any, sandbox: any, sandboxInstanceReady: any): Promise<any> {
  await setTaskState(loopCtx, "init_create_session", "creating agent session");
  if (!sandboxInstanceReady.ok) {
    return {
      id: null,
      status: "error",
      error: sandboxInstanceReady.error ?? "sandbox instance is not ready",
    } as const;
  }

  const { config } = getActorRuntimeContext();
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const sandboxInstance = getSandboxInstance(loopCtx, loopCtx.state.workspaceId, providerId, sandbox.sandboxId);

  const cwd = sandbox.metadata && typeof (sandbox.metadata as any).cwd === "string" ? ((sandbox.metadata as any).cwd as string) : undefined;

  return await sandboxInstance.createSession({
    prompt: typeof loopCtx.state.initialPrompt === "string" ? loopCtx.state.initialPrompt : buildAgentPrompt(loopCtx.state.task),
    cwd,
    agent: (loopCtx.state.agentType ?? config.default_agent) as any,
  });
}

export async function initExposeSandboxActivity(loopCtx: any, body: any, sandbox: any, sandboxInstanceReady?: { actorId?: string | null }): Promise<void> {
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const now = Date.now();
  const db = loopCtx.db;
  const activeCwd = sandbox.metadata && typeof (sandbox.metadata as any).cwd === "string" ? ((sandbox.metadata as any).cwd as string) : null;
  const sandboxActorId = typeof sandboxInstanceReady?.actorId === "string" && sandboxInstanceReady.actorId.length > 0 ? sandboxInstanceReady.actorId : null;

  await db
    .insert(taskSandboxes)
    .values({
      sandboxId: sandbox.sandboxId,
      providerId,
      sandboxActorId,
      switchTarget: sandbox.switchTarget,
      cwd: activeCwd,
      statusMessage: "sandbox ready",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskSandboxes.sandboxId,
      set: {
        providerId,
        sandboxActorId,
        switchTarget: sandbox.switchTarget,
        cwd: activeCwd,
        statusMessage: "sandbox ready",
        updatedAt: now,
      },
    })
    .run();

  await db
    .update(taskRuntime)
    .set({
      activeSandboxId: sandbox.sandboxId,
      activeSwitchTarget: sandbox.switchTarget,
      activeCwd,
      statusMessage: "sandbox ready",
      updatedAt: now,
    })
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .run();
}

export async function initWriteDbActivity(
  loopCtx: any,
  body: any,
  sandbox: any,
  session: any,
  sandboxInstanceReady?: { actorId?: string | null },
): Promise<void> {
  await setTaskState(loopCtx, "init_write_db", "persisting task runtime");
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const { config } = getActorRuntimeContext();
  const now = Date.now();
  const db = loopCtx.db;
  const sessionId = session?.id ?? null;
  const sessionHealthy = Boolean(sessionId) && session?.status !== "error";
  const activeSessionId = sessionHealthy ? sessionId : null;
  const statusMessage = sessionHealthy ? "session created" : session?.status === "error" ? (session.error ?? "session create failed") : "session unavailable";

  const activeCwd = sandbox.metadata && typeof (sandbox.metadata as any).cwd === "string" ? ((sandbox.metadata as any).cwd as string) : null;
  const sandboxActorId = typeof sandboxInstanceReady?.actorId === "string" && sandboxInstanceReady.actorId.length > 0 ? sandboxInstanceReady.actorId : null;

  await db
    .update(taskTable)
    .set({
      providerId,
      status: sessionHealthy ? "running" : "error",
      agentType: loopCtx.state.agentType ?? config.default_agent,
      updatedAt: now,
    })
    .where(eq(taskTable.id, TASK_ROW_ID))
    .run();

  await db
    .insert(taskSandboxes)
    .values({
      sandboxId: sandbox.sandboxId,
      providerId,
      sandboxActorId,
      switchTarget: sandbox.switchTarget,
      cwd: activeCwd,
      statusMessage,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskSandboxes.sandboxId,
      set: {
        providerId,
        sandboxActorId,
        switchTarget: sandbox.switchTarget,
        cwd: activeCwd,
        statusMessage,
        updatedAt: now,
      },
    })
    .run();

  await db
    .insert(taskRuntime)
    .values({
      id: TASK_ROW_ID,
      activeSandboxId: sandbox.sandboxId,
      activeSessionId,
      activeSwitchTarget: sandbox.switchTarget,
      activeCwd,
      statusMessage,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskRuntime.id,
      set: {
        activeSandboxId: sandbox.sandboxId,
        activeSessionId,
        activeSwitchTarget: sandbox.switchTarget,
        activeCwd,
        statusMessage,
        updatedAt: now,
      },
    })
    .run();
}

export async function initStartStatusSyncActivity(loopCtx: any, body: any, sandbox: any, session: any): Promise<void> {
  const sessionId = session?.id ?? null;
  if (!sessionId || session?.status === "error") {
    return;
  }

  await setTaskState(loopCtx, "init_start_status_sync", "starting session status sync");
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const sync = await getOrCreateTaskStatusSync(loopCtx, loopCtx.state.workspaceId, loopCtx.state.repoId, loopCtx.state.taskId, sandbox.sandboxId, sessionId, {
    workspaceId: loopCtx.state.workspaceId,
    repoId: loopCtx.state.repoId,
    taskId: loopCtx.state.taskId,
    providerId,
    sandboxId: sandbox.sandboxId,
    sessionId,
    intervalMs: 2_000,
  });

  await sync.start();
  await sync.force();
}

export async function initCompleteActivity(loopCtx: any, body: any, sandbox: any, session: any): Promise<void> {
  const providerId = body?.providerId ?? loopCtx.state.providerId;
  const sessionId = session?.id ?? null;
  const sessionHealthy = Boolean(sessionId) && session?.status !== "error";
  if (sessionHealthy) {
    await setTaskState(loopCtx, "init_complete", "task initialized");

    const history = await getOrCreateHistory(loopCtx, loopCtx.state.workspaceId, loopCtx.state.repoId);
    await history.append({
      kind: "task.initialized",
      taskId: loopCtx.state.taskId,
      branchName: loopCtx.state.branchName,
      payload: { providerId, sandboxId: sandbox.sandboxId, sessionId },
    });

    loopCtx.state.initialized = true;
    return;
  }

  const detail = session?.status === "error" ? (session.error ?? "session create failed") : "session unavailable";
  await setTaskState(loopCtx, "error", detail);
  await appendHistory(loopCtx, "task.error", {
    detail,
    messages: [detail],
  });
  loopCtx.state.initialized = false;
}

export async function initFailedActivity(loopCtx: any, error: unknown): Promise<void> {
  const now = Date.now();
  const detail = resolveErrorDetail(error);
  const messages = collectErrorMessages(error);
  const db = loopCtx.db;
  const { config, providers } = getActorRuntimeContext();
  const providerId = loopCtx.state.providerId ?? providers.defaultProviderId();

  await db
    .insert(taskTable)
    .values({
      id: TASK_ROW_ID,
      branchName: loopCtx.state.branchName ?? null,
      title: loopCtx.state.title ?? null,
      task: loopCtx.state.task,
      providerId,
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
        providerId,
        status: "error",
        agentType: loopCtx.state.agentType ?? config.default_agent,
        updatedAt: now,
      },
    })
    .run();

  await db
    .insert(taskRuntime)
    .values({
      id: TASK_ROW_ID,
      activeSandboxId: null,
      activeSessionId: null,
      activeSwitchTarget: null,
      activeCwd: null,
      statusMessage: detail,
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
        updatedAt: now,
      },
    })
    .run();

  await appendHistory(loopCtx, "task.error", {
    detail,
    messages,
  });
}
