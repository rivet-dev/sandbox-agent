// @ts-nocheck
import { basename } from "node:path";
import { asc, eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../context.js";
import { getOrCreateTaskStatusSync, getOrCreateProject, getOrCreateWorkspace, getSandboxInstance } from "../handles.js";
import { task as taskTable, taskRuntime, taskWorkbenchSessions } from "./db/schema.js";
import { getCurrentRecord } from "./workflow/common.js";

const STATUS_SYNC_INTERVAL_MS = 1_000;

async function ensureWorkbenchSessionTable(c: any): Promise<void> {
  await c.db.execute(`
    CREATE TABLE IF NOT EXISTS task_workbench_sessions (
      session_id text PRIMARY KEY NOT NULL,
      session_name text NOT NULL,
      model text NOT NULL,
      unread integer DEFAULT 0 NOT NULL,
      draft_text text DEFAULT '' NOT NULL,
      draft_attachments_json text DEFAULT '[]' NOT NULL,
      draft_updated_at integer,
      created integer DEFAULT 1 NOT NULL,
      closed integer DEFAULT 0 NOT NULL,
      thinking_since_ms integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )
  `);
}

function defaultModelForAgent(agentType: string | null | undefined) {
  return agentType === "codex" ? "gpt-4o" : "claude-sonnet-4";
}

function agentKindForModel(model: string) {
  if (model === "gpt-4o" || model === "o3") {
    return "Codex";
  }
  return "Claude";
}

export function agentTypeForModel(model: string) {
  if (model === "gpt-4o" || model === "o3") {
    return "codex";
  }
  return "claude";
}

function repoLabelFromRemote(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  try {
    const url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${(parts[1] ?? "").replace(/\.git$/, "")}`;
    }
  } catch {
    // ignore
  }

  return basename(trimmed.replace(/\.git$/, ""));
}

function parseDraftAttachments(value: string | null | undefined): Array<any> {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function shouldMarkSessionUnreadForStatus(meta: { thinkingSinceMs?: number | null }, status: "running" | "idle" | "error"): boolean {
  if (status === "running") {
    return false;
  }

  // Only mark unread when we observe the transition out of an active thinking state.
  // Repeated idle polls for an already-finished session must not flip unread back on.
  return Boolean(meta.thinkingSinceMs);
}

async function listSessionMetaRows(c: any, options?: { includeClosed?: boolean }): Promise<Array<any>> {
  await ensureWorkbenchSessionTable(c);
  const rows = await c.db.select().from(taskWorkbenchSessions).orderBy(asc(taskWorkbenchSessions.createdAt)).all();
  const mapped = rows.map((row: any) => ({
    ...row,
    id: row.sessionId,
    sessionId: row.sessionId,
    draftAttachments: parseDraftAttachments(row.draftAttachmentsJson),
    draftUpdatedAtMs: row.draftUpdatedAt ?? null,
    unread: row.unread === 1,
    created: row.created === 1,
    closed: row.closed === 1,
  }));

  if (options?.includeClosed === true) {
    return mapped;
  }

  return mapped.filter((row: any) => row.closed !== true);
}

async function nextSessionName(c: any): Promise<string> {
  const rows = await listSessionMetaRows(c, { includeClosed: true });
  return `Session ${rows.length + 1}`;
}

async function readSessionMeta(c: any, sessionId: string): Promise<any | null> {
  await ensureWorkbenchSessionTable(c);
  const row = await c.db.select().from(taskWorkbenchSessions).where(eq(taskWorkbenchSessions.sessionId, sessionId)).get();

  if (!row) {
    return null;
  }

  return {
    ...row,
    id: row.sessionId,
    sessionId: row.sessionId,
    draftAttachments: parseDraftAttachments(row.draftAttachmentsJson),
    draftUpdatedAtMs: row.draftUpdatedAt ?? null,
    unread: row.unread === 1,
    created: row.created === 1,
    closed: row.closed === 1,
  };
}

async function ensureSessionMeta(
  c: any,
  params: {
    sessionId: string;
    model?: string;
    sessionName?: string;
    unread?: boolean;
  },
): Promise<any> {
  await ensureWorkbenchSessionTable(c);
  const existing = await readSessionMeta(c, params.sessionId);
  if (existing) {
    return existing;
  }

  const now = Date.now();
  const sessionName = params.sessionName ?? (await nextSessionName(c));
  const model = params.model ?? defaultModelForAgent(c.state.agentType);
  const unread = params.unread ?? false;

  await c.db
    .insert(taskWorkbenchSessions)
    .values({
      sessionId: params.sessionId,
      sessionName,
      model,
      unread: unread ? 1 : 0,
      draftText: "",
      draftAttachmentsJson: "[]",
      draftUpdatedAt: null,
      created: 1,
      closed: 0,
      thinkingSinceMs: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return await readSessionMeta(c, params.sessionId);
}

async function updateSessionMeta(c: any, sessionId: string, values: Record<string, unknown>): Promise<any> {
  await ensureSessionMeta(c, { sessionId });
  await c.db
    .update(taskWorkbenchSessions)
    .set({
      ...values,
      updatedAt: Date.now(),
    })
    .where(eq(taskWorkbenchSessions.sessionId, sessionId))
    .run();
  return await readSessionMeta(c, sessionId);
}

async function notifyWorkbenchUpdated(c: any): Promise<void> {
  const workspace = await getOrCreateWorkspace(c, c.state.workspaceId);
  await workspace.notifyWorkbenchUpdated({});
}

function shellFragment(parts: string[]): string {
  return parts.join(" && ");
}

async function executeInSandbox(
  c: any,
  params: {
    sandboxId: string;
    cwd: string;
    command: string;
    label: string;
  },
): Promise<{ exitCode: number; result: string }> {
  const { providers } = getActorRuntimeContext();
  const provider = providers.get(c.state.providerId);
  return await provider.executeCommand({
    workspaceId: c.state.workspaceId,
    sandboxId: params.sandboxId,
    command: `bash -lc ${JSON.stringify(shellFragment([`cd ${JSON.stringify(params.cwd)}`, params.command]))}`,
    label: params.label,
  });
}

function parseGitStatus(output: string): Array<{ path: string; type: "M" | "A" | "D" }> {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2).trim();
      const rawPath = line.slice(3).trim();
      const path = rawPath.includes(" -> ") ? (rawPath.split(" -> ").pop() ?? rawPath) : rawPath;
      const type = status.includes("D") ? "D" : status.includes("A") || status === "??" ? "A" : "M";
      return { path, type };
    });
}

function parseNumstat(output: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [addedRaw, removedRaw, ...pathParts] = trimmed.split("\t");
    const path = pathParts.join("\t").trim();
    if (!path) continue;
    map.set(path, {
      added: Number.parseInt(addedRaw ?? "0", 10) || 0,
      removed: Number.parseInt(removedRaw ?? "0", 10) || 0,
    });
  }
  return map;
}

function buildFileTree(paths: string[]): Array<any> {
  const root = {
    children: new Map<string, any>(),
  };

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isDir = index < parts.length - 1;
      let node = current.children.get(part);
      if (!node) {
        node = {
          name: part,
          path: currentPath,
          isDir,
          children: isDir ? new Map<string, any>() : undefined,
        };
        current.children.set(part, node);
      } else if (isDir && !(node.children instanceof Map)) {
        node.children = new Map<string, any>();
      }
      current = node;
    }
  }

  function sortNodes(nodes: Iterable<any>): Array<any> {
    return [...nodes]
      .map((node) =>
        node.isDir
          ? {
              name: node.name,
              path: node.path,
              isDir: true,
              children: sortNodes(node.children?.values?.() ?? []),
            }
          : {
              name: node.name,
              path: node.path,
              isDir: false,
            },
      )
      .sort((left, right) => {
        if (left.isDir !== right.isDir) {
          return left.isDir ? -1 : 1;
        }
        return left.path.localeCompare(right.path);
      });
  }

  return sortNodes(root.children.values());
}

async function collectWorkbenchGitState(c: any, record: any) {
  const activeSandboxId = record.activeSandboxId;
  const activeSandbox = activeSandboxId != null ? ((record.sandboxes ?? []).find((candidate: any) => candidate.sandboxId === activeSandboxId) ?? null) : null;
  const cwd = activeSandbox?.cwd ?? record.sandboxes?.[0]?.cwd ?? null;
  if (!activeSandboxId || !cwd) {
    return {
      fileChanges: [],
      diffs: {},
      fileTree: [],
    };
  }

  const statusResult = await executeInSandbox(c, {
    sandboxId: activeSandboxId,
    cwd,
    command: "git status --porcelain=v1 -uall",
    label: "git status",
  });
  if (statusResult.exitCode !== 0) {
    return {
      fileChanges: [],
      diffs: {},
      fileTree: [],
    };
  }

  const statusRows = parseGitStatus(statusResult.result);
  const numstatResult = await executeInSandbox(c, {
    sandboxId: activeSandboxId,
    cwd,
    command: "git diff --numstat",
    label: "git diff numstat",
  });
  const numstat = parseNumstat(numstatResult.result);
  const diffs: Record<string, string> = {};

  for (const row of statusRows) {
    const diffResult = await executeInSandbox(c, {
      sandboxId: activeSandboxId,
      cwd,
      command: `if git ls-files --error-unmatch -- ${JSON.stringify(row.path)} >/dev/null 2>&1; then git diff -- ${JSON.stringify(row.path)}; else git diff --no-index -- /dev/null ${JSON.stringify(row.path)} || true; fi`,
      label: `git diff ${row.path}`,
    });
    diffs[row.path] = diffResult.result;
  }

  const filesResult = await executeInSandbox(c, {
    sandboxId: activeSandboxId,
    cwd,
    command: "git ls-files --cached --others --exclude-standard",
    label: "git ls-files",
  });
  const allPaths = filesResult.result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    fileChanges: statusRows.map((row) => {
      const counts = numstat.get(row.path) ?? { added: 0, removed: 0 };
      return {
        path: row.path,
        added: counts.added,
        removed: counts.removed,
        type: row.type,
      };
    }),
    diffs,
    fileTree: buildFileTree(allPaths),
  };
}

async function readSessionTranscript(c: any, record: any, sessionId: string) {
  const sandboxId = record.activeSandboxId ?? record.sandboxes?.[0]?.sandboxId ?? null;
  if (!sandboxId) {
    return [];
  }

  const sandbox = getSandboxInstance(c, c.state.workspaceId, c.state.providerId, sandboxId);
  const page = await sandbox.listSessionEvents({
    sessionId,
    limit: 500,
  });
  return page.items.map((event: any) => ({
    id: event.id,
    eventIndex: event.eventIndex,
    sessionId: event.sessionId,
    createdAt: event.createdAt,
    connectionId: event.connectionId,
    sender: event.sender,
    payload: event.payload,
  }));
}

async function activeSessionStatus(c: any, record: any, sessionId: string) {
  if (record.activeSessionId !== sessionId || !record.activeSandboxId) {
    return "idle";
  }

  const sandbox = getSandboxInstance(c, c.state.workspaceId, c.state.providerId, record.activeSandboxId);
  const status = await sandbox.sessionStatus({ sessionId });
  return status.status;
}

async function readPullRequestSummary(c: any, branchName: string | null) {
  if (!branchName) {
    return null;
  }

  try {
    const project = await getOrCreateProject(c, c.state.workspaceId, c.state.repoId, c.state.repoRemote);
    return await project.getPullRequestForBranch({ branchName });
  } catch {
    return null;
  }
}

export async function ensureWorkbenchSeeded(c: any): Promise<any> {
  const record = await getCurrentRecord({ db: c.db, state: c.state });
  if (record.activeSessionId) {
    await ensureSessionMeta(c, {
      sessionId: record.activeSessionId,
      model: defaultModelForAgent(record.agentType),
      sessionName: "Session 1",
    });
  }
  return record;
}

export async function getWorkbenchTask(c: any): Promise<any> {
  const record = await ensureWorkbenchSeeded(c);
  const gitState = await collectWorkbenchGitState(c, record);
  const sessions = await listSessionMetaRows(c);
  const tabs = [];

  for (const meta of sessions) {
    const status = await activeSessionStatus(c, record, meta.sessionId);
    let thinkingSinceMs = meta.thinkingSinceMs ?? null;
    let unread = Boolean(meta.unread);
    if (thinkingSinceMs && status !== "running") {
      thinkingSinceMs = null;
      unread = true;
    }

    tabs.push({
      id: meta.id,
      sessionId: meta.sessionId,
      sessionName: meta.sessionName,
      agent: agentKindForModel(meta.model),
      model: meta.model,
      status,
      thinkingSinceMs: status === "running" ? thinkingSinceMs : null,
      unread,
      created: Boolean(meta.created),
      draft: {
        text: meta.draftText ?? "",
        attachments: Array.isArray(meta.draftAttachments) ? meta.draftAttachments : [],
        updatedAtMs: meta.draftUpdatedAtMs ?? null,
      },
      transcript: await readSessionTranscript(c, record, meta.sessionId),
    });
  }

  return {
    id: c.state.taskId,
    repoId: c.state.repoId,
    title: record.title ?? "New Task",
    status: record.status === "archived" ? "archived" : record.status === "running" ? "running" : record.status === "idle" ? "idle" : "new",
    repoName: repoLabelFromRemote(c.state.repoRemote),
    updatedAtMs: record.updatedAt,
    branch: record.branchName,
    pullRequest: await readPullRequestSummary(c, record.branchName),
    tabs,
    fileChanges: gitState.fileChanges,
    diffs: gitState.diffs,
    fileTree: gitState.fileTree,
  };
}

export async function renameWorkbenchTask(c: any, value: string): Promise<void> {
  const nextTitle = value.trim();
  if (!nextTitle) {
    throw new Error("task title is required");
  }

  await c.db
    .update(taskTable)
    .set({
      title: nextTitle,
      updatedAt: Date.now(),
    })
    .where(eq(taskTable.id, 1))
    .run();
  c.state.title = nextTitle;
  await notifyWorkbenchUpdated(c);
}

export async function renameWorkbenchBranch(c: any, value: string): Promise<void> {
  const nextBranch = value.trim();
  if (!nextBranch) {
    throw new Error("branch name is required");
  }

  const record = await ensureWorkbenchSeeded(c);
  if (!record.branchName) {
    throw new Error("cannot rename branch before task branch exists");
  }
  if (!record.activeSandboxId) {
    throw new Error("cannot rename branch without an active sandbox");
  }
  const activeSandbox = (record.sandboxes ?? []).find((candidate: any) => candidate.sandboxId === record.activeSandboxId) ?? null;
  if (!activeSandbox?.cwd) {
    throw new Error("cannot rename branch without a sandbox cwd");
  }

  const renameResult = await executeInSandbox(c, {
    sandboxId: record.activeSandboxId,
    cwd: activeSandbox.cwd,
    command: [
      `git branch -m ${JSON.stringify(record.branchName)} ${JSON.stringify(nextBranch)}`,
      `if git ls-remote --exit-code --heads origin ${JSON.stringify(record.branchName)} >/dev/null 2>&1; then git push origin :${JSON.stringify(record.branchName)}; fi`,
      `git push origin ${JSON.stringify(nextBranch)}`,
      `git branch --set-upstream-to=${JSON.stringify(`origin/${nextBranch}`)} ${JSON.stringify(nextBranch)} || git push --set-upstream origin ${JSON.stringify(nextBranch)}`,
    ].join(" && "),
    label: `git branch -m ${record.branchName} ${nextBranch}`,
  });
  if (renameResult.exitCode !== 0) {
    throw new Error(`branch rename failed (${renameResult.exitCode}): ${renameResult.result}`);
  }

  await c.db
    .update(taskTable)
    .set({
      branchName: nextBranch,
      updatedAt: Date.now(),
    })
    .where(eq(taskTable.id, 1))
    .run();
  c.state.branchName = nextBranch;

  const project = await getOrCreateProject(c, c.state.workspaceId, c.state.repoId, c.state.repoRemote);
  await project.registerTaskBranch({
    taskId: c.state.taskId,
    branchName: nextBranch,
  });
  await notifyWorkbenchUpdated(c);
}

export async function createWorkbenchSession(c: any, model?: string): Promise<{ tabId: string }> {
  const record = await ensureWorkbenchSeeded(c);
  if (!record.activeSandboxId) {
    throw new Error("cannot create session without an active sandbox");
  }
  const activeSandbox = (record.sandboxes ?? []).find((candidate: any) => candidate.sandboxId === record.activeSandboxId) ?? null;
  const cwd = activeSandbox?.cwd ?? record.sandboxes?.[0]?.cwd ?? null;
  if (!cwd) {
    throw new Error("cannot create session without a sandbox cwd");
  }

  const sandbox = getSandboxInstance(c, c.state.workspaceId, c.state.providerId, record.activeSandboxId);
  const created = await sandbox.createSession({
    prompt: "",
    cwd,
    agent: agentTypeForModel(model ?? defaultModelForAgent(record.agentType)),
  });
  if (!created.id) {
    throw new Error(created.error ?? "sandbox-agent session creation failed");
  }

  await ensureSessionMeta(c, {
    sessionId: created.id,
    model: model ?? defaultModelForAgent(record.agentType),
  });
  await notifyWorkbenchUpdated(c);
  return { tabId: created.id };
}

export async function renameWorkbenchSession(c: any, sessionId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("session title is required");
  }
  await updateSessionMeta(c, sessionId, {
    sessionName: trimmed,
  });
  await notifyWorkbenchUpdated(c);
}

export async function setWorkbenchSessionUnread(c: any, sessionId: string, unread: boolean): Promise<void> {
  await updateSessionMeta(c, sessionId, {
    unread: unread ? 1 : 0,
  });
  await notifyWorkbenchUpdated(c);
}

export async function updateWorkbenchDraft(c: any, sessionId: string, text: string, attachments: Array<any>): Promise<void> {
  await updateSessionMeta(c, sessionId, {
    draftText: text,
    draftAttachmentsJson: JSON.stringify(attachments),
    draftUpdatedAt: Date.now(),
  });
  await notifyWorkbenchUpdated(c);
}

export async function changeWorkbenchModel(c: any, sessionId: string, model: string): Promise<void> {
  await updateSessionMeta(c, sessionId, {
    model,
  });
  await notifyWorkbenchUpdated(c);
}

export async function sendWorkbenchMessage(c: any, sessionId: string, text: string, attachments: Array<any>): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  if (!record.activeSandboxId) {
    throw new Error("cannot send message without an active sandbox");
  }

  await ensureSessionMeta(c, { sessionId });
  const sandbox = getSandboxInstance(c, c.state.workspaceId, c.state.providerId, record.activeSandboxId);
  const prompt = [text.trim(), ...attachments.map((attachment: any) => `@ ${attachment.filePath}:${attachment.lineNumber}\n${attachment.lineContent}`)]
    .filter(Boolean)
    .join("\n\n");
  if (!prompt) {
    throw new Error("message text is required");
  }

  await sandbox.sendPrompt({
    sessionId,
    prompt,
    notification: true,
  });

  await updateSessionMeta(c, sessionId, {
    unread: 0,
    created: 1,
    draftText: "",
    draftAttachmentsJson: "[]",
    draftUpdatedAt: Date.now(),
    thinkingSinceMs: Date.now(),
  });

  await c.db
    .update(taskRuntime)
    .set({
      activeSessionId: sessionId,
      updatedAt: Date.now(),
    })
    .where(eq(taskRuntime.id, 1))
    .run();

  const sync = await getOrCreateTaskStatusSync(c, c.state.workspaceId, c.state.repoId, c.state.taskId, record.activeSandboxId, sessionId, {
    workspaceId: c.state.workspaceId,
    repoId: c.state.repoId,
    taskId: c.state.taskId,
    providerId: c.state.providerId,
    sandboxId: record.activeSandboxId,
    sessionId,
    intervalMs: STATUS_SYNC_INTERVAL_MS,
  });
  await sync.setIntervalMs({ intervalMs: STATUS_SYNC_INTERVAL_MS });
  await sync.start();
  await sync.force();
  await notifyWorkbenchUpdated(c);
}

export async function stopWorkbenchSession(c: any, sessionId: string): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  if (!record.activeSandboxId) {
    return;
  }
  const sandbox = getSandboxInstance(c, c.state.workspaceId, c.state.providerId, record.activeSandboxId);
  await sandbox.cancelSession({ sessionId });
  await updateSessionMeta(c, sessionId, {
    thinkingSinceMs: null,
  });
  await notifyWorkbenchUpdated(c);
}

export async function syncWorkbenchSessionStatus(c: any, sessionId: string, status: "running" | "idle" | "error", at: number): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  const meta = await ensureSessionMeta(c, { sessionId });
  let changed = false;

  if (record.activeSessionId === sessionId) {
    const mappedStatus = status === "running" ? "running" : status === "error" ? "error" : "idle";
    if (record.status !== mappedStatus) {
      await c.db
        .update(taskTable)
        .set({
          status: mappedStatus,
          updatedAt: at,
        })
        .where(eq(taskTable.id, 1))
        .run();
      changed = true;
    }

    const statusMessage = `session:${status}`;
    if (record.statusMessage !== statusMessage) {
      await c.db
        .update(taskRuntime)
        .set({
          statusMessage,
          updatedAt: at,
        })
        .where(eq(taskRuntime.id, 1))
        .run();
      changed = true;
    }
  }

  if (status === "running") {
    if (!meta.thinkingSinceMs) {
      await updateSessionMeta(c, sessionId, {
        thinkingSinceMs: at,
      });
      changed = true;
    }
  } else {
    if (meta.thinkingSinceMs) {
      await updateSessionMeta(c, sessionId, {
        thinkingSinceMs: null,
      });
      changed = true;
    }
    if (!meta.unread && shouldMarkSessionUnreadForStatus(meta, status)) {
      await updateSessionMeta(c, sessionId, {
        unread: 1,
      });
      changed = true;
    }
  }

  if (changed) {
    await notifyWorkbenchUpdated(c);
  }
}

export async function closeWorkbenchSession(c: any, sessionId: string): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  if (!record.activeSandboxId) {
    return;
  }
  const sessions = await listSessionMetaRows(c);
  if (sessions.filter((candidate) => candidate.closed !== true).length <= 1) {
    return;
  }

  const sandbox = getSandboxInstance(c, c.state.workspaceId, c.state.providerId, record.activeSandboxId);
  await sandbox.destroySession({ sessionId });
  await updateSessionMeta(c, sessionId, {
    closed: 1,
    thinkingSinceMs: null,
  });
  if (record.activeSessionId === sessionId) {
    await c.db
      .update(taskRuntime)
      .set({
        activeSessionId: null,
        updatedAt: Date.now(),
      })
      .where(eq(taskRuntime.id, 1))
      .run();
  }
  await notifyWorkbenchUpdated(c);
}

export async function markWorkbenchUnread(c: any): Promise<void> {
  const sessions = await listSessionMetaRows(c);
  const latest = sessions[sessions.length - 1];
  if (!latest) {
    return;
  }
  await updateSessionMeta(c, latest.sessionId, {
    unread: 1,
  });
  await notifyWorkbenchUpdated(c);
}

export async function publishWorkbenchPr(c: any): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  if (!record.branchName) {
    throw new Error("cannot publish PR without a branch");
  }
  const { driver } = getActorRuntimeContext();
  const created = await driver.github.createPr(c.state.repoLocalPath, record.branchName, record.title ?? c.state.task);
  await c.db
    .update(taskTable)
    .set({
      prSubmitted: 1,
      updatedAt: Date.now(),
    })
    .where(eq(taskTable.id, 1))
    .run();
  await notifyWorkbenchUpdated(c);
}

export async function revertWorkbenchFile(c: any, path: string): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  if (!record.activeSandboxId) {
    throw new Error("cannot revert file without an active sandbox");
  }
  const activeSandbox = (record.sandboxes ?? []).find((candidate: any) => candidate.sandboxId === record.activeSandboxId) ?? null;
  if (!activeSandbox?.cwd) {
    throw new Error("cannot revert file without a sandbox cwd");
  }

  const result = await executeInSandbox(c, {
    sandboxId: record.activeSandboxId,
    cwd: activeSandbox.cwd,
    command: `if git ls-files --error-unmatch -- ${JSON.stringify(path)} >/dev/null 2>&1; then git restore --staged --worktree -- ${JSON.stringify(path)} || git checkout -- ${JSON.stringify(path)}; else rm -f ${JSON.stringify(path)}; fi`,
    label: `git restore ${path}`,
  });
  if (result.exitCode !== 0) {
    throw new Error(`file revert failed (${result.exitCode}): ${result.result}`);
  }
  await notifyWorkbenchUpdated(c);
}
