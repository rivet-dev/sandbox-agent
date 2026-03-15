import { describe, expect, it } from "vitest";
import type { TaskWorkbenchSnapshot, WorkbenchSession, WorkbenchTask, WorkbenchModelId, WorkbenchTranscriptEvent } from "@sandbox-agent/foundry-shared";
import { createBackendClient } from "../../src/backend-client.js";
import { requireImportedRepo } from "./helpers.js";

const RUN_WORKBENCH_E2E = process.env.HF_ENABLE_DAEMON_WORKBENCH_E2E === "1";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function workbenchModelEnv(name: string, fallback: WorkbenchModelId): WorkbenchModelId {
  const value = process.env[name]?.trim();
  switch (value) {
    case "claude-sonnet-4":
    case "claude-opus-4":
    case "gpt-5.3-codex":
    case "gpt-5.4":
    case "gpt-5.2-codex":
    case "gpt-5.1-codex-max":
    case "gpt-5.2":
    case "gpt-5.1-codex-mini":
      return value;
    default:
      return fallback;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll<T>(label: string, timeoutMs: number, intervalMs: number, fn: () => Promise<T>, isDone: (value: T) => boolean): Promise<T> {
  const startedAt = Date.now();
  let lastValue: T;

  for (;;) {
    lastValue = await fn();
    if (isDone(lastValue)) {
      return lastValue;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await sleep(intervalMs);
  }
}

function findTask(snapshot: TaskWorkbenchSnapshot, taskId: string): WorkbenchTask {
  const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`task ${taskId} missing from snapshot`);
  }
  return task;
}

function findTab(task: WorkbenchTask, sessionId: string): WorkbenchSession {
  const tab = task.sessions.find((candidate) => candidate.id === sessionId);
  if (!tab) {
    throw new Error(`tab ${sessionId} missing from task ${task.id}`);
  }
  return tab;
}

function extractEventText(event: WorkbenchTranscriptEvent): string {
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "");
  }

  const envelope = payload as {
    method?: unknown;
    params?: unknown;
    result?: unknown;
    error?: unknown;
  };

  const params = envelope.params;
  if (params && typeof params === "object") {
    const update = (params as { update?: unknown }).update;
    if (update && typeof update === "object") {
      const content = (update as { content?: unknown }).content;
      if (content && typeof content === "object") {
        const chunkText = (content as { text?: unknown }).text;
        if (typeof chunkText === "string") {
          return chunkText;
        }
      }
    }

    const text = (params as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
    const prompt = (params as { prompt?: Array<{ text?: unknown }> }).prompt;
    if (Array.isArray(prompt)) {
      const value = prompt
        .map((item) => (typeof item?.text === "string" ? item.text.trim() : ""))
        .filter(Boolean)
        .join("\n");
      if (value) {
        return value;
      }
    }
  }

  const result = envelope.result;
  if (result && typeof result === "object") {
    const text = (result as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }

  if (envelope.error) {
    return JSON.stringify(envelope.error);
  }

  if (typeof envelope.method === "string") {
    return envelope.method;
  }

  return JSON.stringify(payload);
}

function transcriptIncludesAgentText(transcript: WorkbenchTranscriptEvent[], expectedText: string): boolean {
  return transcript
    .filter((event) => event.sender === "agent")
    .map((event) => extractEventText(event))
    .join("")
    .includes(expectedText);
}

describe("e2e(client): workbench flows", () => {
  it.skipIf(!RUN_WORKBENCH_E2E)(
    "creates a task from an imported repo, adds sessions, exchanges messages, and manages workbench state",
    { timeout: 20 * 60_000 },
    async () => {
      const endpoint = process.env.HF_E2E_BACKEND_ENDPOINT?.trim() || "http://127.0.0.1:7741/v1/rivet";
      const organizationId = process.env.HF_E2E_WORKSPACE?.trim() || "default";
      const repoRemote = requiredEnv("HF_E2E_GITHUB_REPO");
      const model = workbenchModelEnv("HF_E2E_MODEL", "gpt-5.3-codex");
      const runId = `wb-${Date.now().toString(36)}`;
      const expectedFile = `${runId}.txt`;
      const expectedInitialReply = `WORKBENCH_READY_${runId}`;
      const expectedReply = `WORKBENCH_ACK_${runId}`;

      const client = createBackendClient({
        endpoint,
        defaultOrganizationId: organizationId,
      });

      const repo = await requireImportedRepo(client, organizationId, repoRemote);
      const created = await client.createWorkbenchTask(organizationId, {
        repoId: repo.repoId,
        title: `Workbench E2E ${runId}`,
        branch: `e2e/${runId}`,
        model,
        task: `Reply with exactly: ${expectedInitialReply}`,
      });

      const provisioned = await poll(
        "task provisioning",
        12 * 60_000,
        2_000,
        async () => findTask(await client.getWorkbench(organizationId), created.taskId),
        (task) => task.branch === `e2e/${runId}` && task.sessions.length > 0,
      );

      const primaryTab = provisioned.sessions[0]!;

      const initialCompleted = await poll(
        "initial agent response",
        12 * 60_000,
        2_000,
        async () => findTask(await client.getWorkbench(organizationId), created.taskId),
        (task) => {
          const tab = findTab(task, primaryTab.id);
          return task.status === "idle" && tab.status === "idle" && transcriptIncludesAgentText(tab.transcript, expectedInitialReply);
        },
      );

      expect(findTab(initialCompleted, primaryTab.id).sessionId).toBeTruthy();
      expect(transcriptIncludesAgentText(findTab(initialCompleted, primaryTab.id).transcript, expectedInitialReply)).toBe(true);

      await client.renameWorkbenchTask(organizationId, {
        taskId: created.taskId,
        value: `Workbench E2E ${runId} Renamed`,
      });
      await client.renameWorkbenchSession(organizationId, {
        taskId: created.taskId,
        sessionId: primaryTab.id,
        title: "Primary Session",
      });

      const secondTab = await client.createWorkbenchSession(organizationId, {
        taskId: created.taskId,
        model,
      });

      await client.renameWorkbenchSession(organizationId, {
        taskId: created.taskId,
        sessionId: secondTab.sessionId,
        title: "Follow-up Session",
      });

      await client.updateWorkbenchDraft(organizationId, {
        taskId: created.taskId,
        sessionId: secondTab.sessionId,
        text: [
          `Create a file named ${expectedFile} in the repo root.`,
          `Write exactly this single line into the file: ${runId}`,
          `Then reply with exactly: ${expectedReply}`,
        ].join("\n"),
        attachments: [
          {
            id: `${expectedFile}:1`,
            filePath: expectedFile,
            lineNumber: 1,
            lineContent: runId,
          },
        ],
      });

      const drafted = findTask(await client.getWorkbench(organizationId), created.taskId);
      expect(findTab(drafted, secondTab.sessionId).draft.text).toContain(expectedReply);
      expect(findTab(drafted, secondTab.sessionId).draft.attachments).toHaveLength(1);

      await client.sendWorkbenchMessage(organizationId, {
        taskId: created.taskId,
        sessionId: secondTab.sessionId,
        text: [
          `Create a file named ${expectedFile} in the repo root.`,
          `Write exactly this single line into the file: ${runId}`,
          `Then reply with exactly: ${expectedReply}`,
        ].join("\n"),
        attachments: [
          {
            id: `${expectedFile}:1`,
            filePath: expectedFile,
            lineNumber: 1,
            lineContent: runId,
          },
        ],
      });

      const withSecondReply = await poll(
        "follow-up session response",
        10 * 60_000,
        2_000,
        async () => findTask(await client.getWorkbench(organizationId), created.taskId),
        (task) => {
          const tab = findTab(task, secondTab.sessionId);
          return (
            tab.status === "idle" && transcriptIncludesAgentText(tab.transcript, expectedReply) && task.fileChanges.some((file) => file.path === expectedFile)
          );
        },
      );

      const secondTranscript = findTab(withSecondReply, secondTab.sessionId).transcript;
      expect(transcriptIncludesAgentText(secondTranscript, expectedReply)).toBe(true);
      expect(withSecondReply.fileChanges.some((file) => file.path === expectedFile)).toBe(true);

      await client.setWorkbenchSessionUnread(organizationId, {
        taskId: created.taskId,
        sessionId: secondTab.sessionId,
        unread: false,
      });
      await client.markWorkbenchUnread(organizationId, { taskId: created.taskId });

      const unreadSnapshot = findTask(await client.getWorkbench(organizationId), created.taskId);
      expect(unreadSnapshot.sessions.some((tab) => tab.unread)).toBe(true);

      await client.closeWorkbenchSession(organizationId, {
        taskId: created.taskId,
        sessionId: secondTab.sessionId,
      });

      const closedSnapshot = await poll(
        "secondary session closed",
        30_000,
        1_000,
        async () => findTask(await client.getWorkbench(organizationId), created.taskId),
        (task) => !task.sessions.some((tab) => tab.id === secondTab.sessionId),
      );
      expect(closedSnapshot.sessions).toHaveLength(1);

      await client.revertWorkbenchFile(organizationId, {
        taskId: created.taskId,
        path: expectedFile,
      });

      const revertedSnapshot = await poll(
        "file revert reflected in workbench",
        30_000,
        1_000,
        async () => findTask(await client.getWorkbench(organizationId), created.taskId),
        (task) => !task.fileChanges.some((file) => file.path === expectedFile),
      );

      expect(revertedSnapshot.fileChanges.some((file) => file.path === expectedFile)).toBe(false);
      expect(revertedSnapshot.title).toBe(`Workbench E2E ${runId} Renamed`);
      expect(findTab(revertedSnapshot, primaryTab.id).sessionName).toBe("Primary Session");
    },
  );
});
