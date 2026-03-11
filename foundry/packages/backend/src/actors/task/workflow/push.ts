// @ts-nocheck
import { eq } from "drizzle-orm";
import { getActorRuntimeContext } from "../../context.js";
import { taskRuntime, taskSandboxes } from "../db/schema.js";
import { TASK_ROW_ID, appendHistory, getCurrentRecord } from "./common.js";

export interface PushActiveBranchOptions {
  reason?: string | null;
  historyKind?: string;
}

export async function pushActiveBranchActivity(loopCtx: any, options: PushActiveBranchOptions = {}): Promise<void> {
  const record = await getCurrentRecord(loopCtx);
  const activeSandboxId = record.activeSandboxId;
  const branchName = loopCtx.state.branchName ?? record.branchName;

  if (!activeSandboxId) {
    throw new Error("cannot push: no active sandbox");
  }
  if (!branchName) {
    throw new Error("cannot push: task branch is not set");
  }

  const activeSandbox = record.sandboxes.find((sandbox: any) => sandbox.sandboxId === activeSandboxId) ?? null;
  const providerId = activeSandbox?.providerId ?? record.providerId;
  const cwd = activeSandbox?.cwd ?? null;
  if (!cwd) {
    throw new Error("cannot push: active sandbox cwd is not set");
  }

  const { providers } = getActorRuntimeContext();
  const provider = providers.get(providerId);

  const now = Date.now();
  await loopCtx.db
    .update(taskRuntime)
    .set({ statusMessage: `pushing branch ${branchName}`, updatedAt: now })
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .run();

  await loopCtx.db
    .update(taskSandboxes)
    .set({ statusMessage: `pushing branch ${branchName}`, updatedAt: now })
    .where(eq(taskSandboxes.sandboxId, activeSandboxId))
    .run();

  const script = [
    "set -euo pipefail",
    `cd ${JSON.stringify(cwd)}`,
    "git rev-parse --verify HEAD >/dev/null",
    "git config credential.helper '!f() { echo username=x-access-token; echo password=${GH_TOKEN:-$GITHUB_TOKEN}; }; f'",
    `git push -u origin ${JSON.stringify(branchName)}`,
  ].join("; ");

  const result = await provider.executeCommand({
    workspaceId: loopCtx.state.workspaceId,
    sandboxId: activeSandboxId,
    command: ["bash", "-lc", JSON.stringify(script)].join(" "),
    label: `git push ${branchName}`,
  });

  if (result.exitCode !== 0) {
    throw new Error(`git push failed (${result.exitCode}): ${result.result}`);
  }

  const updatedAt = Date.now();
  await loopCtx.db
    .update(taskRuntime)
    .set({ statusMessage: `push complete for ${branchName}`, updatedAt })
    .where(eq(taskRuntime.id, TASK_ROW_ID))
    .run();

  await loopCtx.db
    .update(taskSandboxes)
    .set({ statusMessage: `push complete for ${branchName}`, updatedAt })
    .where(eq(taskSandboxes.sandboxId, activeSandboxId))
    .run();

  await appendHistory(loopCtx, options.historyKind ?? "task.push", {
    reason: options.reason ?? null,
    branchName,
    sandboxId: activeSandboxId,
  });
}
