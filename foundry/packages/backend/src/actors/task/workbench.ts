// @ts-nocheck
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";
import { asc, eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../context.js";
import { getOrCreateRepository, getOrCreateTaskSandbox, getOrCreateOrganization, getTaskSandbox, selfTask } from "../handles.js";
import { SANDBOX_REPO_CWD } from "../sandbox/index.js";
import { resolveSandboxProviderId } from "../../sandbox-config.js";
import { resolveOrganizationGithubAuth } from "../../services/github-auth.js";
import { githubRepoFullNameFromRemote } from "../../services/repo.js";
import { task as taskTable, taskRuntime, taskSandboxes, taskWorkbenchSessions } from "./db/schema.js";
import { getCurrentRecord } from "./workflow/common.js";

function emptyGitState() {
  return {
    fileChanges: [],
    diffs: {},
    fileTree: [],
    updatedAt: null as number | null,
  };
}

async function ensureWorkbenchSessionTable(c: any): Promise<void> {
  await c.db.execute(`
    CREATE TABLE IF NOT EXISTS task_workbench_sessions (
      session_id text PRIMARY KEY NOT NULL,
      sandbox_session_id text,
      session_name text NOT NULL,
      model text NOT NULL,
      status text DEFAULT 'ready' NOT NULL,
      error_message text,
      transcript_json text DEFAULT '[]' NOT NULL,
      transcript_updated_at integer,
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
  await c.db.execute(`ALTER TABLE task_workbench_sessions ADD COLUMN sandbox_session_id text`).catch(() => {});
  await c.db.execute(`ALTER TABLE task_workbench_sessions ADD COLUMN status text DEFAULT 'ready' NOT NULL`).catch(() => {});
  await c.db.execute(`ALTER TABLE task_workbench_sessions ADD COLUMN error_message text`).catch(() => {});
  await c.db.execute(`ALTER TABLE task_workbench_sessions ADD COLUMN transcript_json text DEFAULT '[]' NOT NULL`).catch(() => {});
  await c.db.execute(`ALTER TABLE task_workbench_sessions ADD COLUMN transcript_updated_at integer`).catch(() => {});
}

async function ensureTaskRuntimeCacheColumns(c: any): Promise<void> {
  await c.db.execute(`ALTER TABLE task_runtime ADD COLUMN git_state_json text`).catch(() => {});
  await c.db.execute(`ALTER TABLE task_runtime ADD COLUMN git_state_updated_at integer`).catch(() => {});
  await c.db.execute(`ALTER TABLE task_runtime ADD COLUMN provision_stage text`).catch(() => {});
  await c.db.execute(`ALTER TABLE task_runtime ADD COLUMN provision_stage_updated_at integer`).catch(() => {});
}

function defaultModelForAgent(agentType: string | null | undefined) {
  return agentType === "codex" ? "gpt-5.3-codex" : "claude-sonnet-4";
}

function isCodexModel(model: string) {
  return model.startsWith("gpt-") || model.startsWith("o");
}

function agentKindForModel(model: string) {
  if (isCodexModel(model)) {
    return "Codex";
  }
  return "Claude";
}

export function agentTypeForModel(model: string) {
  if (isCodexModel(model)) {
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

function parseTranscript(value: string | null | undefined): Array<any> {
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

function parseGitState(value: string | null | undefined): { fileChanges: Array<any>; diffs: Record<string, string>; fileTree: Array<any> } {
  if (!value) {
    return emptyGitState();
  }

  try {
    const parsed = JSON.parse(value) as {
      fileChanges?: unknown;
      diffs?: unknown;
      fileTree?: unknown;
    };
    return {
      fileChanges: Array.isArray(parsed.fileChanges) ? parsed.fileChanges : [],
      diffs: parsed.diffs && typeof parsed.diffs === "object" ? (parsed.diffs as Record<string, string>) : {},
      fileTree: Array.isArray(parsed.fileTree) ? parsed.fileTree : [],
    };
  } catch {
    return emptyGitState();
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

export function shouldRecreateSessionForModelChange(meta: {
  status: "pending_provision" | "pending_session_create" | "ready" | "error";
  sandboxSessionId?: string | null;
  created?: boolean;
  transcript?: Array<any>;
}): boolean {
  if (meta.status !== "ready" || !meta.sandboxSessionId) {
    return false;
  }

  if (meta.created) {
    return false;
  }

  return !Array.isArray(meta.transcript) || meta.transcript.length === 0;
}

async function listSessionMetaRows(c: any, options?: { includeClosed?: boolean }): Promise<Array<any>> {
  await ensureWorkbenchSessionTable(c);
  const rows = await c.db.select().from(taskWorkbenchSessions).orderBy(asc(taskWorkbenchSessions.createdAt)).all();
  const mapped = rows.map((row: any) => ({
    ...row,
    id: row.sessionId,
    sessionId: row.sessionId,
    sandboxSessionId: row.sandboxSessionId ?? null,
    status: row.status ?? "ready",
    errorMessage: row.errorMessage ?? null,
    transcript: parseTranscript(row.transcriptJson),
    transcriptUpdatedAt: row.transcriptUpdatedAt ?? null,
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
    sandboxSessionId: row.sandboxSessionId ?? null,
    status: row.status ?? "ready",
    errorMessage: row.errorMessage ?? null,
    transcript: parseTranscript(row.transcriptJson),
    transcriptUpdatedAt: row.transcriptUpdatedAt ?? null,
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
    sandboxSessionId?: string | null;
    model?: string;
    sessionName?: string;
    unread?: boolean;
    created?: boolean;
    status?: "pending_provision" | "pending_session_create" | "ready" | "error";
    errorMessage?: string | null;
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
      sandboxSessionId: params.sandboxSessionId ?? null,
      sessionName,
      model,
      status: params.status ?? "ready",
      errorMessage: params.errorMessage ?? null,
      transcriptJson: "[]",
      transcriptUpdatedAt: null,
      unread: unread ? 1 : 0,
      draftText: "",
      draftAttachmentsJson: "[]",
      draftUpdatedAt: null,
      created: params.created === false ? 0 : 1,
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

async function readSessionMetaBySandboxSessionId(c: any, sandboxSessionId: string): Promise<any | null> {
  await ensureWorkbenchSessionTable(c);
  const row = await c.db.select().from(taskWorkbenchSessions).where(eq(taskWorkbenchSessions.sandboxSessionId, sandboxSessionId)).get();
  if (!row) {
    return null;
  }
  return await readSessionMeta(c, row.sessionId);
}

async function requireReadySessionMeta(c: any, sessionId: string): Promise<any> {
  const meta = await readSessionMeta(c, sessionId);
  if (!meta) {
    throw new Error(`Unknown workbench session: ${sessionId}`);
  }
  if (meta.status !== "ready" || !meta.sandboxSessionId) {
    throw new Error(meta.errorMessage ?? "This workbench session is still preparing");
  }
  return meta;
}

export function requireSendableSessionMeta(meta: any, sessionId: string): any {
  if (!meta) {
    throw new Error(`Unknown workbench session: ${sessionId}`);
  }
  if (meta.status !== "ready" || !meta.sandboxSessionId) {
    throw new Error(`Session is not ready (status: ${meta.status}). Wait for session provisioning to complete.`);
  }
  return meta;
}

function shellFragment(parts: string[]): string {
  return parts.join(" && ");
}

function stableSandboxId(c: any): string {
  return c.state.taskId;
}

async function getTaskSandboxRuntime(
  c: any,
  record: any,
): Promise<{
  sandbox: any;
  sandboxId: string;
  sandboxProviderId: string;
  switchTarget: string;
  cwd: string;
}> {
  const { config } = getActorRuntimeContext();
  const sandboxId = stableSandboxId(c);
  const sandboxProviderId = resolveSandboxProviderId(config, record.sandboxProviderId ?? c.state.sandboxProviderId ?? null);
  const sandbox = await getOrCreateTaskSandbox(c, c.state.organizationId, sandboxId, {});
  const actorId = typeof sandbox.resolve === "function" ? await sandbox.resolve().catch(() => null) : null;
  const switchTarget = sandboxProviderId === "local" ? `sandbox://local/${sandboxId}` : `sandbox://e2b/${sandboxId}`;
  const now = Date.now();

  await c.db
    .insert(taskSandboxes)
    .values({
      sandboxId,
      sandboxProviderId,
      sandboxActorId: typeof actorId === "string" ? actorId : null,
      switchTarget,
      cwd: SANDBOX_REPO_CWD,
      statusMessage: "sandbox ready",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: taskSandboxes.sandboxId,
      set: {
        sandboxProviderId,
        sandboxActorId: typeof actorId === "string" ? actorId : null,
        switchTarget,
        cwd: SANDBOX_REPO_CWD,
        updatedAt: now,
      },
    })
    .run();

  await c.db
    .update(taskRuntime)
    .set({
      activeSandboxId: sandboxId,
      activeSwitchTarget: switchTarget,
      activeCwd: SANDBOX_REPO_CWD,
      updatedAt: now,
    })
    .where(eq(taskRuntime.id, 1))
    .run();

  return {
    sandbox,
    sandboxId,
    sandboxProviderId,
    switchTarget,
    cwd: SANDBOX_REPO_CWD,
  };
}

/**
 * Track whether the sandbox repo has been fully prepared (cloned + fetched + checked out)
 * for the current actor lifecycle. Subsequent calls can skip the expensive `git fetch`
 * when `skipFetch` is true (used by sendWorkbenchMessage to avoid blocking on every prompt).
 */
let sandboxRepoPrepared = false;

async function ensureSandboxRepo(c: any, sandbox: any, record: any, opts?: { skipFetchIfPrepared?: boolean }): Promise<void> {
  if (!record.branchName) {
    throw new Error("cannot prepare a sandbox repo before the task branch exists");
  }

  // If the repo was already prepared and the caller allows skipping fetch, just return.
  // The clone, fetch, and checkout already happened on a prior call.
  if (opts?.skipFetchIfPrepared && sandboxRepoPrepared) {
    return;
  }

  const auth = await resolveOrganizationGithubAuth(c, c.state.organizationId);
  const repository = await getOrCreateRepository(c, c.state.organizationId, c.state.repoId, c.state.repoRemote);
  const metadata = await repository.getRepositoryMetadata({});
  const baseRef = metadata.defaultBranch ?? "main";
  const sandboxRepoRoot = dirname(SANDBOX_REPO_CWD);
  const script = [
    "set -euo pipefail",
    `mkdir -p ${JSON.stringify(sandboxRepoRoot)}`,
    "git config --global credential.helper '!f() { echo username=x-access-token; echo password=${GH_TOKEN:-$GITHUB_TOKEN}; }; f'",
    `if [ ! -d ${JSON.stringify(`${SANDBOX_REPO_CWD}/.git`)} ]; then rm -rf ${JSON.stringify(SANDBOX_REPO_CWD)} && git clone ${JSON.stringify(
      c.state.repoRemote,
    )} ${JSON.stringify(SANDBOX_REPO_CWD)}; fi`,
    `cd ${JSON.stringify(SANDBOX_REPO_CWD)}`,
    "git fetch origin --prune",
    `if git show-ref --verify --quiet refs/remotes/origin/${JSON.stringify(record.branchName).slice(1, -1)}; then target_ref=${JSON.stringify(
      `origin/${record.branchName}`,
    )}; else target_ref=${JSON.stringify(baseRef)}; fi`,
    `git checkout -B ${JSON.stringify(record.branchName)} \"$target_ref\"`,
  ];
  const result = await sandbox.runProcess({
    command: "bash",
    args: ["-lc", script.join("; ")],
    cwd: "/",
    env: auth?.githubToken
      ? {
          GH_TOKEN: auth.githubToken,
          GITHUB_TOKEN: auth.githubToken,
        }
      : undefined,
    timeoutMs: 5 * 60_000,
  });

  if ((result.exitCode ?? 0) !== 0) {
    throw new Error(`sandbox repo preparation failed (${result.exitCode ?? 1}): ${[result.stdout, result.stderr].filter(Boolean).join("")}`);
  }

  sandboxRepoPrepared = true;
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
  const record = await ensureWorkbenchSeeded(c);
  const runtime = await getTaskSandboxRuntime(c, record);
  await ensureSandboxRepo(c, runtime.sandbox, record);
  const response = await runtime.sandbox.runProcess({
    command: "bash",
    args: ["-lc", shellFragment([`cd ${JSON.stringify(params.cwd)}`, params.command])],
    cwd: "/",
    timeoutMs: 5 * 60_000,
  });

  return {
    exitCode: response.exitCode ?? 0,
    result: [response.stdout, response.stderr].filter(Boolean).join(""),
  };
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

  const diffs: Record<string, string> = {};
  for (const row of statusRows) {
    const diffResult = await executeInSandbox(c, {
      sandboxId: activeSandboxId,
      cwd,
      command: `git diff -- ${JSON.stringify(row.path)}`,
      label: `git diff ${row.path}`,
    });
    diffs[row.path] = diffResult.exitCode === 0 ? diffResult.result : "";
  }

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

async function readCachedGitState(c: any): Promise<{ fileChanges: Array<any>; diffs: Record<string, string>; fileTree: Array<any>; updatedAt: number | null }> {
  await ensureTaskRuntimeCacheColumns(c);
  const row = await c.db
    .select({
      gitStateJson: taskRuntime.gitStateJson,
      gitStateUpdatedAt: taskRuntime.gitStateUpdatedAt,
    })
    .from(taskRuntime)
    .where(eq(taskRuntime.id, 1))
    .get();
  const parsed = parseGitState(row?.gitStateJson);
  return {
    ...parsed,
    updatedAt: row?.gitStateUpdatedAt ?? null,
  };
}

async function writeCachedGitState(c: any, gitState: { fileChanges: Array<any>; diffs: Record<string, string>; fileTree: Array<any> }): Promise<void> {
  await ensureTaskRuntimeCacheColumns(c);
  const now = Date.now();
  await c.db
    .update(taskRuntime)
    .set({
      gitStateJson: JSON.stringify(gitState),
      gitStateUpdatedAt: now,
      updatedAt: now,
    })
    .where(eq(taskRuntime.id, 1))
    .run();
}

async function readSessionTranscript(c: any, record: any, sessionId: string) {
  const sandboxId = record.activeSandboxId ?? stableSandboxId(c);
  if (!sandboxId) {
    return [];
  }

  const sandbox = getTaskSandbox(c, c.state.organizationId, sandboxId);
  const page = await sandbox.getEvents({
    sessionId,
    limit: 100,
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

async function writeSessionTranscript(c: any, sessionId: string, transcript: Array<any>): Promise<void> {
  await updateSessionMeta(c, sessionId, {
    transcriptJson: JSON.stringify(transcript),
    transcriptUpdatedAt: Date.now(),
  });
}

async function enqueueWorkbenchRefresh(
  c: any,
  command: "task.command.workbench.refresh_derived" | "task.command.workbench.refresh_session_transcript",
  body: Record<string, unknown>,
): Promise<void> {
  const self = selfTask(c);
  await self.send(command, body, { wait: false });
}

async function enqueueWorkbenchEnsureSession(c: any, sessionId: string): Promise<void> {
  const self = selfTask(c);
  await self.send(
    "task.command.workbench.ensure_session",
    {
      sessionId,
    },
    {
      wait: false,
    },
  );
}

function pendingWorkbenchSessionStatus(record: any): "pending_provision" | "pending_session_create" {
  return record.activeSandboxId ? "pending_session_create" : "pending_provision";
}

async function maybeScheduleWorkbenchRefreshes(c: any, record: any, sessions: Array<any>): Promise<void> {
  const gitState = await readCachedGitState(c);
  if (record.activeSandboxId && !gitState.updatedAt) {
    await enqueueWorkbenchRefresh(c, "task.command.workbench.refresh_derived", {});
  }

  for (const session of sessions) {
    if (session.closed || session.status !== "ready" || !session.sandboxSessionId || session.transcriptUpdatedAt) {
      continue;
    }
    await enqueueWorkbenchRefresh(c, "task.command.workbench.refresh_session_transcript", {
      sessionId: session.sandboxSessionId,
    });
  }
}

function activeSessionStatus(record: any, sessionId: string) {
  if (record.activeSessionId !== sessionId) {
    return "idle";
  }

  if (record.status === "running") {
    return "running";
  }
  if (record.status === "error") {
    return "error";
  }
  return "idle";
}

async function readPullRequestSummary(c: any, branchName: string | null) {
  if (!branchName) {
    return null;
  }

  try {
    const repository = await getOrCreateRepository(c, c.state.organizationId, c.state.repoId, c.state.repoRemote);
    return await repository.getPullRequestForBranch({ branchName });
  } catch {
    return null;
  }
}

export async function ensureWorkbenchSeeded(c: any): Promise<any> {
  await ensureTaskRuntimeCacheColumns(c);
  const record = await getCurrentRecord({ db: c.db, state: c.state });
  if (record.activeSessionId) {
    await ensureSessionMeta(c, {
      sessionId: record.activeSessionId,
      sandboxSessionId: record.activeSessionId,
      model: defaultModelForAgent(record.agentType),
      sessionName: "Session 1",
      status: "ready",
    });
  }
  return record;
}

function buildSessionSummary(record: any, meta: any): any {
  const derivedSandboxSessionId = meta.status === "ready" ? (meta.sandboxSessionId ?? null) : null;
  const sessionStatus =
    meta.status === "pending_provision" || meta.status === "pending_session_create"
      ? meta.status
      : meta.status === "ready" && derivedSandboxSessionId
        ? activeSessionStatus(record, derivedSandboxSessionId)
        : meta.status === "error"
          ? "error"
          : "ready";
  let thinkingSinceMs = meta.thinkingSinceMs ?? null;
  let unread = Boolean(meta.unread);
  if (thinkingSinceMs && sessionStatus !== "running") {
    thinkingSinceMs = null;
    unread = true;
  }

  return {
    id: meta.id,
    sessionId: meta.sessionId,
    sandboxSessionId: derivedSandboxSessionId,
    sessionName: meta.sessionName,
    agent: agentKindForModel(meta.model),
    model: meta.model,
    status: sessionStatus,
    thinkingSinceMs: sessionStatus === "running" ? thinkingSinceMs : null,
    unread,
    created: Boolean(meta.created || derivedSandboxSessionId),
    errorMessage: meta.errorMessage ?? null,
  };
}

function buildSessionDetailFromMeta(record: any, meta: any): any {
  const summary = buildSessionSummary(record, meta);
  return {
    sessionId: meta.sessionId,
    sandboxSessionId: summary.sandboxSessionId ?? null,
    sessionName: summary.sessionName,
    agent: summary.agent,
    model: summary.model,
    status: summary.status,
    thinkingSinceMs: summary.thinkingSinceMs,
    unread: summary.unread,
    created: summary.created,
    errorMessage: summary.errorMessage,
    draft: {
      text: meta.draftText ?? "",
      attachments: Array.isArray(meta.draftAttachments) ? meta.draftAttachments : [],
      updatedAtMs: meta.draftUpdatedAtMs ?? null,
    },
    transcript: meta.transcript ?? [],
  };
}

/**
 * Builds a WorkbenchTaskSummary from local task actor state. Task actors push
 * this to the parent organization actor so organization sidebar reads stay local.
 */
export async function buildTaskSummary(c: any): Promise<any> {
  const record = await ensureWorkbenchSeeded(c);
  const sessions = await listSessionMetaRows(c);
  await maybeScheduleWorkbenchRefreshes(c, record, sessions);

  return {
    id: c.state.taskId,
    repoId: c.state.repoId,
    title: record.title ?? "New Task",
    status: record.status ?? "new",
    repoName: repoLabelFromRemote(c.state.repoRemote),
    updatedAtMs: record.updatedAt,
    branch: record.branchName,
    pullRequest: await readPullRequestSummary(c, record.branchName),
    sessionsSummary: sessions.map((meta) => buildSessionSummary(record, meta)),
  };
}

/**
 * Builds a WorkbenchTaskDetail from local task actor state for direct task
 * subscribers. This is a full replacement payload, not a patch.
 */
export async function buildTaskDetail(c: any): Promise<any> {
  const record = await ensureWorkbenchSeeded(c);
  const gitState = await readCachedGitState(c);
  const sessions = await listSessionMetaRows(c);
  await maybeScheduleWorkbenchRefreshes(c, record, sessions);
  const summary = await buildTaskSummary(c);

  return {
    ...summary,
    task: record.task,
    agentType: record.agentType === "claude" || record.agentType === "codex" ? record.agentType : null,
    runtimeStatus: record.status,
    statusMessage: record.statusMessage ?? null,
    activeSessionId: record.activeSessionId ?? null,
    diffStat: record.diffStat ?? null,
    prUrl: record.prUrl ?? null,
    reviewStatus: record.reviewStatus ?? null,
    fileChanges: gitState.fileChanges,
    diffs: gitState.diffs,
    fileTree: gitState.fileTree,
    minutesUsed: 0,
    sandboxes: (record.sandboxes ?? []).map((sandbox: any) => ({
      sandboxProviderId: sandbox.sandboxProviderId,
      sandboxId: sandbox.sandboxId,
      cwd: sandbox.cwd ?? null,
    })),
    activeSandboxId: record.activeSandboxId ?? null,
  };
}

/**
 * Builds a WorkbenchSessionDetail for a specific session.
 */
export async function buildSessionDetail(c: any, sessionId: string): Promise<any> {
  const record = await ensureWorkbenchSeeded(c);
  const meta = await readSessionMeta(c, sessionId);
  if (!meta || meta.closed) {
    throw new Error(`Unknown workbench session: ${sessionId}`);
  }

  if (!meta.sandboxSessionId) {
    return buildSessionDetailFromMeta(record, meta);
  }

  try {
    const transcript = await readSessionTranscript(c, record, meta.sandboxSessionId);
    if (JSON.stringify(meta.transcript ?? []) !== JSON.stringify(transcript)) {
      await writeSessionTranscript(c, meta.sessionId, transcript);
      return buildSessionDetailFromMeta(record, {
        ...meta,
        transcript,
        transcriptUpdatedAt: Date.now(),
      });
    }
  } catch {
    // Session detail reads should degrade to cached transcript data if the live sandbox is unavailable.
  }

  return buildSessionDetailFromMeta(record, meta);
}

export async function getTaskSummary(c: any): Promise<any> {
  return await buildTaskSummary(c);
}

export async function getTaskDetail(c: any): Promise<any> {
  return await buildTaskDetail(c);
}

export async function getSessionDetail(c: any, sessionId: string): Promise<any> {
  return await buildSessionDetail(c, sessionId);
}

/**
 * Replaces the old notifyWorkbenchUpdated pattern.
 *
 * The task actor emits two kinds of updates:
 * - Push summary state up to the parent organization actor so the sidebar
 *   materialized projection stays current.
 * - Broadcast full detail/session payloads down to direct task subscribers.
 */
export async function broadcastTaskUpdate(c: any, options?: { sessionId?: string }): Promise<void> {
  const organization = await getOrCreateOrganization(c, c.state.organizationId);
  await organization.applyTaskSummaryUpdate({ taskSummary: await buildTaskSummary(c) });
  c.broadcast("taskUpdated", {
    type: "taskDetailUpdated",
    detail: await buildTaskDetail(c),
  });

  if (options?.sessionId) {
    c.broadcast("sessionUpdated", {
      type: "sessionUpdated",
      session: await buildSessionDetail(c, options.sessionId),
    });
  }
}

export async function refreshWorkbenchDerivedState(c: any): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  const gitState = await collectWorkbenchGitState(c, record);
  await writeCachedGitState(c, gitState);
  await broadcastTaskUpdate(c);
}

export async function refreshWorkbenchSessionTranscript(c: any, sessionId: string): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  const meta = (await readSessionMetaBySandboxSessionId(c, sessionId)) ?? (await readSessionMeta(c, sessionId));
  if (!meta?.sandboxSessionId) {
    return;
  }

  const transcript = await readSessionTranscript(c, record, meta.sandboxSessionId);
  await writeSessionTranscript(c, meta.sessionId, transcript);
  await broadcastTaskUpdate(c, { sessionId: meta.sessionId });
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
  await broadcastTaskUpdate(c);
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

  const repository = await getOrCreateRepository(c, c.state.organizationId, c.state.repoId, c.state.repoRemote);
  await repository.registerTaskBranch({
    taskId: c.state.taskId,
    branchName: nextBranch,
  });
  await broadcastTaskUpdate(c);
}

export async function createWorkbenchSession(c: any, model?: string): Promise<{ sessionId: string }> {
  const sessionId = `session-${randomUUID()}`;
  const record = await ensureWorkbenchSeeded(c);
  await ensureSessionMeta(c, {
    sessionId,
    model: model ?? defaultModelForAgent(record.agentType),
    sandboxSessionId: null,
    status: pendingWorkbenchSessionStatus(record),
    created: false,
  });
  await broadcastTaskUpdate(c, { sessionId: sessionId });
  await enqueueWorkbenchEnsureSession(c, sessionId);
  return { sessionId };
}

export async function ensureWorkbenchSession(c: any, sessionId: string, model?: string): Promise<void> {
  const meta = await readSessionMeta(c, sessionId);
  if (!meta || meta.closed) {
    return;
  }

  const record = await ensureWorkbenchSeeded(c);
  if (meta.sandboxSessionId && meta.status === "ready") {
    await enqueueWorkbenchRefresh(c, "task.command.workbench.refresh_session_transcript", {
      sessionId: meta.sandboxSessionId,
    });
    await broadcastTaskUpdate(c, { sessionId: sessionId });
    return;
  }

  await updateSessionMeta(c, sessionId, {
    sandboxSessionId: meta.sandboxSessionId ?? sessionId,
    status: "pending_session_create",
    errorMessage: null,
  });

  try {
    const runtime = await getTaskSandboxRuntime(c, record);
    await ensureSandboxRepo(c, runtime.sandbox, record);
    await runtime.sandbox.createSession({
      id: meta.sandboxSessionId ?? sessionId,
      agent: agentTypeForModel(model ?? meta.model ?? defaultModelForAgent(record.agentType)),
      model: model ?? meta.model ?? defaultModelForAgent(record.agentType),
      sessionInit: {
        cwd: runtime.cwd,
      },
    });

    await updateSessionMeta(c, sessionId, {
      sandboxSessionId: meta.sandboxSessionId ?? sessionId,
      status: "ready",
      errorMessage: null,
    });
    await enqueueWorkbenchRefresh(c, "task.command.workbench.refresh_session_transcript", {
      sessionId: meta.sandboxSessionId ?? sessionId,
    });
  } catch (error) {
    await updateSessionMeta(c, sessionId, {
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  await broadcastTaskUpdate(c, { sessionId: sessionId });
}

export async function enqueuePendingWorkbenchSessions(c: any): Promise<void> {
  const self = selfTask(c);
  const pending = (await listSessionMetaRows(c, { includeClosed: true })).filter(
    (row) => row.closed !== true && row.status !== "ready" && row.status !== "error",
  );

  for (const row of pending) {
    await self.send(
      "task.command.workbench.ensure_session",
      {
        sessionId: row.sessionId,
        model: row.model,
      },
      {
        wait: false,
      },
    );
  }
}

export async function renameWorkbenchSession(c: any, sessionId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error("session title is required");
  }
  await updateSessionMeta(c, sessionId, {
    sessionName: trimmed,
  });
  await broadcastTaskUpdate(c, { sessionId });
}

export async function setWorkbenchSessionUnread(c: any, sessionId: string, unread: boolean): Promise<void> {
  await updateSessionMeta(c, sessionId, {
    unread: unread ? 1 : 0,
  });
  await broadcastTaskUpdate(c, { sessionId });
}

export async function updateWorkbenchDraft(c: any, sessionId: string, text: string, attachments: Array<any>): Promise<void> {
  await updateSessionMeta(c, sessionId, {
    draftText: text,
    draftAttachmentsJson: JSON.stringify(attachments),
    draftUpdatedAt: Date.now(),
  });
  await broadcastTaskUpdate(c, { sessionId });
}

export async function changeWorkbenchModel(c: any, sessionId: string, model: string): Promise<void> {
  const meta = await readSessionMeta(c, sessionId);
  if (!meta || meta.closed) {
    return;
  }

  if (meta.model === model) {
    return;
  }

  const record = await ensureWorkbenchSeeded(c);
  let nextMeta = await updateSessionMeta(c, sessionId, {
    model,
  });
  let shouldEnsure = nextMeta.status === "pending_provision" || nextMeta.status === "pending_session_create" || nextMeta.status === "error";

  if (shouldRecreateSessionForModelChange(nextMeta)) {
    const sandbox = getTaskSandbox(c, c.state.organizationId, stableSandboxId(c));
    await sandbox.destroySession(nextMeta.sandboxSessionId);
    nextMeta = await updateSessionMeta(c, sessionId, {
      sandboxSessionId: null,
      status: pendingWorkbenchSessionStatus(record),
      errorMessage: null,
      transcriptJson: "[]",
      transcriptUpdatedAt: null,
      thinkingSinceMs: null,
    });
    shouldEnsure = true;
  } else if (nextMeta.status === "ready" && nextMeta.sandboxSessionId) {
    const sandbox = getTaskSandbox(c, c.state.organizationId, stableSandboxId(c));
    if (typeof sandbox.rawSendSessionMethod === "function") {
      try {
        await sandbox.rawSendSessionMethod(nextMeta.sandboxSessionId, "session/set_config_option", {
          configId: "model",
          value: model,
        });
      } catch {
        // Some agents do not allow live model updates. Preserve the new preference in metadata.
      }
    }
  } else if (nextMeta.status !== "ready") {
    nextMeta = await updateSessionMeta(c, sessionId, {
      status: pendingWorkbenchSessionStatus(record),
      errorMessage: null,
    });
  }

  if (shouldEnsure) {
    await enqueueWorkbenchEnsureSession(c, sessionId);
  }
  await broadcastTaskUpdate(c, { sessionId });
}

export async function sendWorkbenchMessage(c: any, sessionId: string, text: string, attachments: Array<any>): Promise<void> {
  const meta = requireSendableSessionMeta(await readSessionMeta(c, sessionId), sessionId);
  const record = await ensureWorkbenchSeeded(c);
  const runtime = await getTaskSandboxRuntime(c, record);
  // Skip git fetch on subsequent messages — the repo was already prepared during session
  // creation. This avoids a 5-30s network round-trip to GitHub on every prompt.
  await ensureSandboxRepo(c, runtime.sandbox, record, { skipFetchIfPrepared: true });
  const prompt = [text.trim(), ...attachments.map((attachment: any) => `@ ${attachment.filePath}:${attachment.lineNumber}\n${attachment.lineContent}`)].filter(
    Boolean,
  );
  if (prompt.length === 0) {
    throw new Error("message text is required");
  }

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
      activeSessionId: meta.sandboxSessionId,
      updatedAt: Date.now(),
    })
    .where(eq(taskRuntime.id, 1))
    .run();

  await syncWorkbenchSessionStatus(c, meta.sandboxSessionId, "running", Date.now());

  try {
    await runtime.sandbox.sendPrompt({
      sessionId: meta.sandboxSessionId,
      prompt: prompt.join("\n\n"),
    });
    await syncWorkbenchSessionStatus(c, meta.sandboxSessionId, "idle", Date.now());
  } catch (error) {
    await updateSessionMeta(c, sessionId, {
      status: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    await syncWorkbenchSessionStatus(c, meta.sandboxSessionId, "error", Date.now());
    throw error;
  }
}

export async function stopWorkbenchSession(c: any, sessionId: string): Promise<void> {
  const meta = await requireReadySessionMeta(c, sessionId);
  const sandbox = getTaskSandbox(c, c.state.organizationId, stableSandboxId(c));
  await sandbox.destroySession(meta.sandboxSessionId);
  await updateSessionMeta(c, sessionId, {
    thinkingSinceMs: null,
  });
  await broadcastTaskUpdate(c, { sessionId });
}

export async function syncWorkbenchSessionStatus(c: any, sessionId: string, status: "running" | "idle" | "error", at: number): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  const meta = (await readSessionMetaBySandboxSessionId(c, sessionId)) ?? (await ensureSessionMeta(c, { sessionId: sessionId, sandboxSessionId: sessionId }));
  let changed = false;

  if (record.activeSessionId === sessionId || record.activeSessionId === meta.sandboxSessionId) {
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
    await enqueueWorkbenchRefresh(c, "task.command.workbench.refresh_session_transcript", {
      sessionId,
    });
    if (status !== "running") {
      await enqueueWorkbenchRefresh(c, "task.command.workbench.refresh_derived", {});
    }
    await broadcastTaskUpdate(c, { sessionId: meta.sessionId });
  }
}

export async function closeWorkbenchSession(c: any, sessionId: string): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  const sessions = await listSessionMetaRows(c);
  if (sessions.filter((candidate) => candidate.closed !== true).length <= 1) {
    return;
  }

  const meta = await readSessionMeta(c, sessionId);
  if (!meta) {
    return;
  }
  if (meta.sandboxSessionId) {
    const sandbox = getTaskSandbox(c, c.state.organizationId, stableSandboxId(c));
    await sandbox.destroySession(meta.sandboxSessionId);
  }
  await updateSessionMeta(c, sessionId, {
    closed: 1,
    thinkingSinceMs: null,
  });
  if (record.activeSessionId === sessionId || record.activeSessionId === meta.sandboxSessionId) {
    await c.db
      .update(taskRuntime)
      .set({
        activeSessionId: null,
        updatedAt: Date.now(),
      })
      .where(eq(taskRuntime.id, 1))
      .run();
  }
  await broadcastTaskUpdate(c);
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
  await broadcastTaskUpdate(c, { sessionId: latest.sessionId });
}

export async function publishWorkbenchPr(c: any): Promise<void> {
  const record = await ensureWorkbenchSeeded(c);
  if (!record.branchName) {
    throw new Error("cannot publish PR without a branch");
  }
  const repository = await getOrCreateRepository(c, c.state.organizationId, c.state.repoId, c.state.repoRemote);
  const metadata = await repository.getRepositoryMetadata({});
  const repoFullName = metadata.fullName ?? githubRepoFullNameFromRemote(c.state.repoRemote);
  if (!repoFullName) {
    throw new Error(`Unable to resolve GitHub repository for ${c.state.repoRemote}`);
  }
  const { driver } = getActorRuntimeContext();
  const auth = await resolveOrganizationGithubAuth(c, c.state.organizationId);
  await driver.github.createPr(repoFullName, record.branchName, record.title ?? c.state.task, undefined, {
    githubToken: auth?.githubToken ?? null,
    baseBranch: metadata.defaultBranch ?? undefined,
  });
  await c.db
    .update(taskTable)
    .set({
      prSubmitted: 1,
      updatedAt: Date.now(),
    })
    .where(eq(taskTable.id, 1))
    .run();
  await broadcastTaskUpdate(c);
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
  await enqueueWorkbenchRefresh(c, "task.command.workbench.refresh_derived", {});
  await broadcastTaskUpdate(c);
}
