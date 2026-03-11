// @ts-nocheck
import { eq } from "drizzle-orm";
import type { HandoffRecord, HandoffStatus } from "@sandbox-agent/foundry-shared";
import { getOrCreateWorkspace } from "../../handles.js";
import { handoff as handoffTable, handoffRuntime, handoffSandboxes } from "../db/schema.js";
import { historyKey } from "../../keys.js";

export const HANDOFF_ROW_ID = 1;

export function collectErrorMessages(error: unknown): string[] {
  if (error == null) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current != null && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      const message = current.message?.trim();
      if (message) {
        out.push(message);
      }
      current = (current as { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "string") {
      const message = current.trim();
      if (message) {
        out.push(message);
      }
      break;
    }

    break;
  }

  return out.filter((msg, index) => out.indexOf(msg) === index);
}

export function resolveErrorDetail(error: unknown): string {
  const messages = collectErrorMessages(error);
  if (messages.length === 0) {
    return String(error);
  }

  const nonWorkflowWrapper = messages.find((msg) => !/^Step\s+"[^"]+"\s+failed\b/i.test(msg));
  return nonWorkflowWrapper ?? messages[0]!;
}

export function buildAgentPrompt(task: string): string {
  return task.trim();
}

export async function setHandoffState(ctx: any, status: HandoffStatus, statusMessage?: string): Promise<void> {
  const now = Date.now();
  const db = ctx.db;
  await db.update(handoffTable).set({ status, updatedAt: now }).where(eq(handoffTable.id, HANDOFF_ROW_ID)).run();

  if (statusMessage != null) {
    await db
      .insert(handoffRuntime)
      .values({
        id: HANDOFF_ROW_ID,
        activeSandboxId: null,
        activeSessionId: null,
        activeSwitchTarget: null,
        activeCwd: null,
        statusMessage,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: handoffRuntime.id,
        set: {
          statusMessage,
          updatedAt: now,
        },
      })
      .run();
  }

  const workspace = await getOrCreateWorkspace(ctx, ctx.state.workspaceId);
  await workspace.notifyWorkbenchUpdated({});
}

export async function getCurrentRecord(ctx: any): Promise<HandoffRecord> {
  const db = ctx.db;
  const row = await db
    .select({
      branchName: handoffTable.branchName,
      title: handoffTable.title,
      task: handoffTable.task,
      providerId: handoffTable.providerId,
      status: handoffTable.status,
      statusMessage: handoffRuntime.statusMessage,
      activeSandboxId: handoffRuntime.activeSandboxId,
      activeSessionId: handoffRuntime.activeSessionId,
      agentType: handoffTable.agentType,
      prSubmitted: handoffTable.prSubmitted,
      createdAt: handoffTable.createdAt,
      updatedAt: handoffTable.updatedAt,
    })
    .from(handoffTable)
    .leftJoin(handoffRuntime, eq(handoffTable.id, handoffRuntime.id))
    .where(eq(handoffTable.id, HANDOFF_ROW_ID))
    .get();

  if (!row) {
    throw new Error(`Handoff not found: ${ctx.state.handoffId}`);
  }

  const sandboxes = await db
    .select({
      sandboxId: handoffSandboxes.sandboxId,
      providerId: handoffSandboxes.providerId,
      sandboxActorId: handoffSandboxes.sandboxActorId,
      switchTarget: handoffSandboxes.switchTarget,
      cwd: handoffSandboxes.cwd,
      createdAt: handoffSandboxes.createdAt,
      updatedAt: handoffSandboxes.updatedAt,
    })
    .from(handoffSandboxes)
    .all();

  return {
    workspaceId: ctx.state.workspaceId,
    repoId: ctx.state.repoId,
    repoRemote: ctx.state.repoRemote,
    handoffId: ctx.state.handoffId,
    branchName: row.branchName,
    title: row.title,
    task: row.task,
    providerId: row.providerId,
    status: row.status,
    statusMessage: row.statusMessage ?? null,
    activeSandboxId: row.activeSandboxId ?? null,
    activeSessionId: row.activeSessionId ?? null,
    sandboxes: sandboxes.map((sb) => ({
      sandboxId: sb.sandboxId,
      providerId: sb.providerId,
      sandboxActorId: sb.sandboxActorId ?? null,
      switchTarget: sb.switchTarget,
      cwd: sb.cwd ?? null,
      createdAt: sb.createdAt,
      updatedAt: sb.updatedAt,
    })),
    agentType: row.agentType ?? null,
    prSubmitted: Boolean(row.prSubmitted),
    diffStat: null,
    hasUnpushed: null,
    conflictsWithMain: null,
    parentBranch: null,
    prUrl: null,
    prAuthor: null,
    ciStatus: null,
    reviewStatus: null,
    reviewer: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as HandoffRecord;
}

export async function appendHistory(ctx: any, kind: string, payload: Record<string, unknown>): Promise<void> {
  const client = ctx.client();
  const history = await client.history.getOrCreate(historyKey(ctx.state.workspaceId, ctx.state.repoId), {
    createWithInput: { workspaceId: ctx.state.workspaceId, repoId: ctx.state.repoId },
  });
  await history.append({
    kind,
    handoffId: ctx.state.handoffId,
    branchName: ctx.state.branchName,
    payload,
  });

  const workspace = await getOrCreateWorkspace(ctx, ctx.state.workspaceId);
  await workspace.notifyWorkbenchUpdated({});
}
