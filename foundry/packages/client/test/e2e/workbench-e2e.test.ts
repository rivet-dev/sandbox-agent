import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { HandoffWorkbenchSnapshot, WorkbenchAgentTab, WorkbenchHandoff, WorkbenchModelId, WorkbenchTranscriptEvent } from "@sandbox-agent/foundry-shared";
import { createBackendClient } from "../../src/backend-client.js";

const RUN_WORKBENCH_E2E = process.env.HF_ENABLE_DAEMON_WORKBENCH_E2E === "1";
const execFileAsync = promisify(execFile);

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
    case "gpt-4o":
    case "o3":
      return value;
    default:
      return fallback;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function seedSandboxFile(workspaceId: string, handoffId: string, filePath: string, content: string): Promise<void> {
  const repoPath = `/root/.local/share/foundry/local-sandboxes/${workspaceId}/${handoffId}/repo`;
  const script = [
    `cd ${JSON.stringify(repoPath)}`,
    `mkdir -p ${JSON.stringify(filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : ".")}`,
    `printf '%s\\n' ${JSON.stringify(content)} > ${JSON.stringify(filePath)}`,
  ].join(" && ");
  await execFileAsync("docker", ["exec", "foundry-backend-1", "bash", "-lc", script]);
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

function findHandoff(snapshot: HandoffWorkbenchSnapshot, handoffId: string): WorkbenchHandoff {
  const handoff = snapshot.handoffs.find((candidate) => candidate.id === handoffId);
  if (!handoff) {
    throw new Error(`handoff ${handoffId} missing from snapshot`);
  }
  return handoff;
}

function findTab(handoff: WorkbenchHandoff, tabId: string): WorkbenchAgentTab {
  const tab = handoff.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) {
    throw new Error(`tab ${tabId} missing from handoff ${handoff.id}`);
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
  it.skipIf(!RUN_WORKBENCH_E2E)("creates a handoff, adds sessions, exchanges messages, and manages workbench state", { timeout: 20 * 60_000 }, async () => {
    const endpoint = process.env.HF_E2E_BACKEND_ENDPOINT?.trim() || "http://127.0.0.1:7741/api/rivet";
    const workspaceId = process.env.HF_E2E_WORKSPACE?.trim() || "default";
    const repoRemote = requiredEnv("HF_E2E_GITHUB_REPO");
    const model = workbenchModelEnv("HF_E2E_MODEL", "gpt-4o");
    const runId = `wb-${Date.now().toString(36)}`;
    const expectedFile = `${runId}.txt`;
    const expectedInitialReply = `WORKBENCH_READY_${runId}`;
    const expectedReply = `WORKBENCH_ACK_${runId}`;

    const client = createBackendClient({
      endpoint,
      defaultWorkspaceId: workspaceId,
    });

    const repo = await client.addRepo(workspaceId, repoRemote);
    const created = await client.createWorkbenchHandoff(workspaceId, {
      repoId: repo.repoId,
      title: `Workbench E2E ${runId}`,
      branch: `e2e/${runId}`,
      model,
      task: `Reply with exactly: ${expectedInitialReply}`,
    });

    const provisioned = await poll(
      "handoff provisioning",
      12 * 60_000,
      2_000,
      async () => findHandoff(await client.getWorkbench(workspaceId), created.handoffId),
      (handoff) => handoff.branch === `e2e/${runId}` && handoff.tabs.length > 0,
    );

    const primaryTab = provisioned.tabs[0]!;

    const initialCompleted = await poll(
      "initial agent response",
      12 * 60_000,
      2_000,
      async () => findHandoff(await client.getWorkbench(workspaceId), created.handoffId),
      (handoff) => {
        const tab = findTab(handoff, primaryTab.id);
        return handoff.status === "idle" && tab.status === "idle" && transcriptIncludesAgentText(tab.transcript, expectedInitialReply);
      },
    );

    expect(findTab(initialCompleted, primaryTab.id).sessionId).toBeTruthy();
    expect(transcriptIncludesAgentText(findTab(initialCompleted, primaryTab.id).transcript, expectedInitialReply)).toBe(true);

    await seedSandboxFile(workspaceId, created.handoffId, expectedFile, runId);

    const fileSeeded = await poll(
      "seeded sandbox file reflected in workbench",
      30_000,
      1_000,
      async () => findHandoff(await client.getWorkbench(workspaceId), created.handoffId),
      (handoff) => handoff.fileChanges.some((file) => file.path === expectedFile),
    );
    expect(fileSeeded.fileChanges.some((file) => file.path === expectedFile)).toBe(true);

    await client.renameWorkbenchHandoff(workspaceId, {
      handoffId: created.handoffId,
      value: `Workbench E2E ${runId} Renamed`,
    });
    await client.renameWorkbenchSession(workspaceId, {
      handoffId: created.handoffId,
      tabId: primaryTab.id,
      title: "Primary Session",
    });

    const secondTab = await client.createWorkbenchSession(workspaceId, {
      handoffId: created.handoffId,
      model,
    });

    await client.renameWorkbenchSession(workspaceId, {
      handoffId: created.handoffId,
      tabId: secondTab.tabId,
      title: "Follow-up Session",
    });

    await client.updateWorkbenchDraft(workspaceId, {
      handoffId: created.handoffId,
      tabId: secondTab.tabId,
      text: `Reply with exactly: ${expectedReply}`,
      attachments: [
        {
          id: `${expectedFile}:1`,
          filePath: expectedFile,
          lineNumber: 1,
          lineContent: runId,
        },
      ],
    });

    const drafted = findHandoff(await client.getWorkbench(workspaceId), created.handoffId);
    expect(findTab(drafted, secondTab.tabId).draft.text).toContain(expectedReply);
    expect(findTab(drafted, secondTab.tabId).draft.attachments).toHaveLength(1);

    await client.sendWorkbenchMessage(workspaceId, {
      handoffId: created.handoffId,
      tabId: secondTab.tabId,
      text: `Reply with exactly: ${expectedReply}`,
      attachments: [],
    });

    const withSecondReply = await poll(
      "follow-up session response",
      10 * 60_000,
      2_000,
      async () => findHandoff(await client.getWorkbench(workspaceId), created.handoffId),
      (handoff) => {
        const tab = findTab(handoff, secondTab.tabId);
        return tab.status === "idle" && transcriptIncludesAgentText(tab.transcript, expectedReply);
      },
    );

    const secondTranscript = findTab(withSecondReply, secondTab.tabId).transcript;
    expect(transcriptIncludesAgentText(secondTranscript, expectedReply)).toBe(true);

    await client.setWorkbenchSessionUnread(workspaceId, {
      handoffId: created.handoffId,
      tabId: secondTab.tabId,
      unread: false,
    });
    await client.markWorkbenchUnread(workspaceId, { handoffId: created.handoffId });

    const unreadSnapshot = findHandoff(await client.getWorkbench(workspaceId), created.handoffId);
    expect(unreadSnapshot.tabs.some((tab) => tab.unread)).toBe(true);

    await client.closeWorkbenchSession(workspaceId, {
      handoffId: created.handoffId,
      tabId: secondTab.tabId,
    });

    const closedSnapshot = await poll(
      "secondary session closed",
      30_000,
      1_000,
      async () => findHandoff(await client.getWorkbench(workspaceId), created.handoffId),
      (handoff) => !handoff.tabs.some((tab) => tab.id === secondTab.tabId),
    );
    expect(closedSnapshot.tabs).toHaveLength(1);

    await client.revertWorkbenchFile(workspaceId, {
      handoffId: created.handoffId,
      path: expectedFile,
    });

    const revertedSnapshot = await poll(
      "file revert reflected in workbench",
      30_000,
      1_000,
      async () => findHandoff(await client.getWorkbench(workspaceId), created.handoffId),
      (handoff) => !handoff.fileChanges.some((file) => file.path === expectedFile),
    );

    expect(revertedSnapshot.fileChanges.some((file) => file.path === expectedFile)).toBe(false);
    expect(revertedSnapshot.title).toBe(`Workbench E2E ${runId} Renamed`);
    expect(findTab(revertedSnapshot, primaryTab.id).sessionName).toBe("Primary Session");
  });
});
