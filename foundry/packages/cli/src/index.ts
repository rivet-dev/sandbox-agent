#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { AgentTypeSchema, CreateHandoffInputSchema, type HandoffRecord } from "@sandbox-agent/foundry-shared";
import { readBackendMetadata, createBackendClientFromConfig, formatRelativeAge, groupHandoffStatus, summarizeHandoffs } from "@sandbox-agent/foundry-client";
import { ensureBackendRunning, getBackendStatus, parseBackendPort, stopBackend } from "./backend/manager.js";
import { openEditorForTask } from "./task-editor.js";
import { spawnCreateTmuxWindow } from "./tmux.js";
import { loadConfig, resolveWorkspace, saveConfig } from "./workspace/config.js";

async function ensureBunRuntime(): Promise<void> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return;
  }

  const preferred = process.env.HF_BUN?.trim();
  const candidates = [preferred, `${homedir()}/.bun/bin/bun`, "bun"].filter((item): item is string => Boolean(item && item.length > 0));

  for (const candidate of candidates) {
    const command = candidate;
    const canExec = command === "bun" || existsSync(command);
    if (!canExec) {
      continue;
    }

    const child = spawnSync(command, [process.argv[1] ?? "", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });

    if (child.error) {
      continue;
    }

    const code = child.status ?? 1;
    process.exit(code);
  }

  throw new Error("hf requires Bun runtime. Set HF_BUN or install Bun at ~/.bun/bin/bun.");
}

async function runTuiCommand(config: ReturnType<typeof loadConfig>, workspaceId: string): Promise<void> {
  const mod = await import("./tui.js");
  await mod.runTui(config, workspaceId);
}

function readOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseIntOption(value: string | undefined, fallback: number, label: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (!item) {
      continue;
    }

    if (item.startsWith("--")) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        i += 1;
      }
      continue;
    }
    out.push(item);
  }
  return out;
}

function printUsage(): void {
  console.log(`
Usage:
  hf backend start [--host HOST] [--port PORT]
  hf backend stop [--host HOST] [--port PORT]
  hf backend status
  hf backend inspect
  hf status [--workspace WS] [--json]
  hf history [--workspace WS] [--limit N] [--branch NAME] [--handoff ID] [--json]
  hf workspace use <name>
  hf tui [--workspace WS]

  hf create [task] [--workspace WS] --repo <git-remote> [--name NAME|--branch NAME] [--title TITLE] [--agent claude|codex] [--on BRANCH]
  hf list [--workspace WS] [--format table|json] [--full]
  hf switch [handoff-id | -] [--workspace WS]
  hf attach <handoff-id> [--workspace WS]
  hf merge <handoff-id> [--workspace WS]
  hf archive <handoff-id> [--workspace WS]
  hf push <handoff-id> [--workspace WS]
  hf sync <handoff-id> [--workspace WS]
  hf kill <handoff-id> [--workspace WS] [--delete-branch] [--abandon]
  hf prune [--workspace WS] [--dry-run] [--yes]
  hf statusline [--workspace WS] [--format table|claude-code]
  hf db path
  hf db nuke

Tips:
  hf status --help    Show status output format and examples
  hf history --help   Show history output format and examples
  hf switch -         Switch to most recently updated handoff
`);
}

function printStatusUsage(): void {
  console.log(`
Usage:
  hf status [--workspace WS] [--json]

Text Output:
  workspace=<workspace-id>
  backend running=<true|false> pid=<pid|unknown> version=<version|unknown>
  handoffs total=<number>
  status queued=<n> running=<n> idle=<n> archived=<n> killed=<n> error=<n>
  providers <provider-id>=<count> ...
  providers -

JSON Output:
  {
    "workspaceId": "default",
    "backend": { ...backend status object... },
    "handoffs": {
      "total": 4,
      "byStatus": { "queued": 0, "running": 1, "idle": 2, "archived": 1, "killed": 0, "error": 0 },
      "byProvider": { "daytona": 4 }
    }
  }
`);
}

function printHistoryUsage(): void {
  console.log(`
Usage:
  hf history [--workspace WS] [--limit N] [--branch NAME] [--handoff ID] [--json]

Text Output:
  <iso8601>\t<event-kind>\t<branch|handoff|repo|->\t<payload-json>
  <iso8601>\t<event-kind>\t<branch|handoff|repo|->\t<payload-json...>
  no events

Notes:
  - payload is truncated to 120 characters in text mode.
  - --limit defaults to 20.

JSON Output:
  [
    {
      "id": "...",
      "workspaceId": "default",
      "kind": "handoff.created",
      "handoffId": "...",
      "repoId": "...",
      "branchName": "feature/foo",
      "payloadJson": "{\\"providerId\\":\\"daytona\\"}",
      "createdAt": 1770607522229
    }
  ]
`);
}

async function handleBackend(args: string[]): Promise<void> {
  const sub = args[0] ?? "start";
  const config = loadConfig();
  const host = readOption(args, "--host") ?? config.backend.host;
  const port = parseBackendPort(readOption(args, "--port"), config.backend.port);
  const backendConfig = {
    ...config,
    backend: {
      ...config.backend,
      host,
      port,
    },
  };

  if (sub === "start") {
    await ensureBackendRunning(backendConfig);
    const status = await getBackendStatus(host, port);
    const pid = status.pid ?? "unknown";
    const version = status.version ?? "unknown";
    const stale = status.running && !status.versionCurrent ? " [outdated]" : "";
    console.log(`running=true pid=${pid} version=${version}${stale} log=${status.logPath}`);
    return;
  }

  if (sub === "stop") {
    await stopBackend(host, port);
    console.log(`running=false host=${host} port=${port}`);
    return;
  }

  if (sub === "status") {
    const status = await getBackendStatus(host, port);
    const pid = status.pid ?? "unknown";
    const version = status.version ?? "unknown";
    const stale = status.running && !status.versionCurrent ? " [outdated]" : "";
    console.log(`running=${status.running} pid=${pid} version=${version}${stale} host=${host} port=${port} log=${status.logPath}`);
    return;
  }

  if (sub === "inspect") {
    await ensureBackendRunning(backendConfig);
    const metadata = await readBackendMetadata({
      endpoint: `http://${host}:${port}/api/rivet`,
      timeoutMs: 4_000,
    });
    const managerEndpoint = metadata.clientEndpoint ?? `http://${host}:${port}`;
    const inspectorUrl = `https://inspect.rivet.dev?u=${encodeURIComponent(managerEndpoint)}`;
    const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
    spawnSync(openCmd, [inspectorUrl], { stdio: "ignore" });
    console.log(inspectorUrl);
    return;
  }

  throw new Error(`Unknown backend subcommand: ${sub}`);
}

async function handleWorkspace(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "use") {
    throw new Error("Usage: hf workspace use <name>");
  }

  const name = args[1];
  if (!name) {
    throw new Error("Missing workspace name");
  }

  const config = loadConfig();
  config.workspace.default = name;
  saveConfig(config);

  const client = createBackendClientFromConfig(config);
  try {
    await client.useWorkspace(name);
  } catch {
    // Backend may not be running yet. Config is already updated.
  }

  console.log(`workspace=${name}`);
}

async function handleList(args: string[]): Promise<void> {
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const format = readOption(args, "--format") ?? "table";
  const full = hasFlag(args, "--full");
  const client = createBackendClientFromConfig(config);
  const rows = await client.listHandoffs(workspaceId);

  if (format === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("no handoffs");
    return;
  }

  for (const row of rows) {
    const age = formatRelativeAge(row.updatedAt);
    let line = `${row.handoffId}\t${row.branchName}\t${row.status}\t${row.providerId}\t${age}`;
    if (full) {
      const task = row.task.length > 60 ? `${row.task.slice(0, 57)}...` : row.task;
      line += `\t${row.title}\t${task}\t${row.activeSessionId ?? "-"}\t${row.activeSandboxId ?? "-"}`;
    }
    console.log(line);
  }
}

async function handlePush(args: string[]): Promise<void> {
  const handoffId = positionals(args)[0];
  if (!handoffId) {
    throw new Error("Missing handoff id for push");
  }
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const client = createBackendClientFromConfig(config);
  await client.runAction(workspaceId, handoffId, "push");
  console.log("ok");
}

async function handleSync(args: string[]): Promise<void> {
  const handoffId = positionals(args)[0];
  if (!handoffId) {
    throw new Error("Missing handoff id for sync");
  }
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const client = createBackendClientFromConfig(config);
  await client.runAction(workspaceId, handoffId, "sync");
  console.log("ok");
}

async function handleKill(args: string[]): Promise<void> {
  const handoffId = positionals(args)[0];
  if (!handoffId) {
    throw new Error("Missing handoff id for kill");
  }
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const deleteBranch = hasFlag(args, "--delete-branch");
  const abandon = hasFlag(args, "--abandon");

  if (deleteBranch) {
    console.log("info: --delete-branch flag set, branch will be deleted after kill");
  }
  if (abandon) {
    console.log("info: --abandon flag set, Graphite abandon will be attempted");
  }

  const client = createBackendClientFromConfig(config);
  await client.runAction(workspaceId, handoffId, "kill");
  console.log("ok");
}

async function handlePrune(args: string[]): Promise<void> {
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const dryRun = hasFlag(args, "--dry-run");
  const yes = hasFlag(args, "--yes");
  const client = createBackendClientFromConfig(config);
  const rows = await client.listHandoffs(workspaceId);
  const prunable = rows.filter((r) => r.status === "archived" || r.status === "killed");

  if (prunable.length === 0) {
    console.log("nothing to prune");
    return;
  }

  for (const row of prunable) {
    const age = formatRelativeAge(row.updatedAt);
    console.log(`${dryRun ? "[dry-run] " : ""}${row.handoffId}\t${row.branchName}\t${row.status}\t${age}`);
  }

  if (dryRun) {
    console.log(`\n${prunable.length} handoff(s) would be pruned`);
    return;
  }

  if (!yes) {
    console.log("\nnot yet implemented: auto-pruning requires confirmation");
    return;
  }

  console.log(`\n${prunable.length} handoff(s) would be pruned (pruning not yet implemented)`);
}

async function handleStatusline(args: string[]): Promise<void> {
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const format = readOption(args, "--format") ?? "table";
  const client = createBackendClientFromConfig(config);
  const rows = await client.listHandoffs(workspaceId);
  const summary = summarizeHandoffs(rows);
  const running = summary.byStatus.running;
  const idle = summary.byStatus.idle;
  const errorCount = summary.byStatus.error;

  if (format === "claude-code") {
    console.log(`hf:${running}R/${idle}I/${errorCount}E`);
    return;
  }

  console.log(`running=${running} idle=${idle} error=${errorCount}`);
}

async function handleDb(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "path") {
    const config = loadConfig();
    const dbPath = config.backend.dbPath.replace(/^~/, homedir());
    console.log(dbPath);
    return;
  }

  if (sub === "nuke") {
    console.log("WARNING: hf db nuke would delete the entire database. This is a placeholder and does not delete anything.");
    return;
  }

  throw new Error("Usage: hf db path | hf db nuke");
}

async function waitForHandoffReady(
  client: ReturnType<typeof createBackendClientFromConfig>,
  workspaceId: string,
  handoffId: string,
  timeoutMs: number,
): Promise<HandoffRecord> {
  const start = Date.now();
  let delayMs = 250;

  for (;;) {
    const record = await client.getHandoff(workspaceId, handoffId);
    const hasName = Boolean(record.branchName && record.title);
    const hasSandbox = Boolean(record.activeSandboxId);

    if (record.status === "error") {
      throw new Error(`handoff entered error state while provisioning: ${handoffId}`);
    }
    if (hasName && hasSandbox) {
      return record;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for handoff provisioning: ${handoffId}`);
    }

    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(Math.round(delayMs * 1.5), 2_000);
  }
}

async function handleCreate(args: string[]): Promise<void> {
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);

  const repoRemote = readOption(args, "--repo");
  if (!repoRemote) {
    throw new Error("Missing required --repo <git-remote>");
  }
  const explicitBranchName = readOption(args, "--name") ?? readOption(args, "--branch");
  const explicitTitle = readOption(args, "--title");

  const agentRaw = readOption(args, "--agent");
  const agentType = agentRaw ? AgentTypeSchema.parse(agentRaw) : undefined;
  const onBranch = readOption(args, "--on");

  const taskFromArgs = positionals(args).join(" ").trim();
  const task = taskFromArgs || openEditorForTask();

  const client = createBackendClientFromConfig(config);
  const repo = await client.addRepo(workspaceId, repoRemote);

  const payload = CreateHandoffInputSchema.parse({
    workspaceId,
    repoId: repo.repoId,
    task,
    explicitTitle: explicitTitle || undefined,
    explicitBranchName: explicitBranchName || undefined,
    agentType,
    onBranch,
  });

  const created = await client.createHandoff(payload);
  const handoff = await waitForHandoffReady(client, workspaceId, created.handoffId, 180_000);
  const switched = await client.switchHandoff(workspaceId, handoff.handoffId);
  const attached = await client.attachHandoff(workspaceId, handoff.handoffId);

  console.log(`Branch:   ${handoff.branchName ?? "-"}`);
  console.log(`Handoff:  ${handoff.handoffId}`);
  console.log(`Provider: ${handoff.providerId}`);
  console.log(`Session:  ${attached.sessionId ?? "none"}`);
  console.log(`Target:   ${switched.switchTarget || attached.target}`);
  console.log(`Title:    ${handoff.title ?? "-"}`);

  const tmuxResult = spawnCreateTmuxWindow({
    branchName: handoff.branchName ?? handoff.handoffId,
    targetPath: switched.switchTarget || attached.target,
    sessionId: attached.sessionId,
  });

  if (tmuxResult.created) {
    console.log(`Window:   created (${handoff.branchName})`);
    return;
  }

  console.log("");
  console.log(`Run: hf switch ${handoff.handoffId}`);
  if ((switched.switchTarget || attached.target).startsWith("/")) {
    console.log(`cd ${switched.switchTarget || attached.target}`);
  }
}

async function handleTui(args: string[]): Promise<void> {
  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  await runTuiCommand(config, workspaceId);
}

async function handleStatus(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printStatusUsage();
    return;
  }

  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const client = createBackendClientFromConfig(config);
  const backendStatus = await getBackendStatus(config.backend.host, config.backend.port);
  const rows = await client.listHandoffs(workspaceId);
  const summary = summarizeHandoffs(rows);

  if (hasFlag(args, "--json")) {
    console.log(
      JSON.stringify(
        {
          workspaceId,
          backend: backendStatus,
          handoffs: {
            total: summary.total,
            byStatus: summary.byStatus,
            byProvider: summary.byProvider,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`workspace=${workspaceId}`);
  console.log(`backend running=${backendStatus.running} pid=${backendStatus.pid ?? "unknown"} version=${backendStatus.version ?? "unknown"}`);
  console.log(`handoffs total=${summary.total}`);
  console.log(
    `status queued=${summary.byStatus.queued} running=${summary.byStatus.running} idle=${summary.byStatus.idle} archived=${summary.byStatus.archived} killed=${summary.byStatus.killed} error=${summary.byStatus.error}`,
  );
  const providerSummary = Object.entries(summary.byProvider)
    .map(([provider, count]) => `${provider}=${count}`)
    .join(" ");
  console.log(`providers ${providerSummary || "-"}`);
}

async function handleHistory(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    printHistoryUsage();
    return;
  }

  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const limit = parseIntOption(readOption(args, "--limit"), 20, "limit");
  const branch = readOption(args, "--branch");
  const handoffId = readOption(args, "--handoff");
  const client = createBackendClientFromConfig(config);
  const rows = await client.listHistory({
    workspaceId,
    limit,
    branch: branch || undefined,
    handoffId: handoffId || undefined,
  });

  if (hasFlag(args, "--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("no events");
    return;
  }

  for (const row of rows) {
    const ts = new Date(row.createdAt).toISOString();
    const target = row.branchName || row.handoffId || row.repoId || "-";
    let payload = row.payloadJson;
    if (payload.length > 120) {
      payload = `${payload.slice(0, 117)}...`;
    }
    console.log(`${ts}\t${row.kind}\t${target}\t${payload}`);
  }
}

async function handleSwitchLike(cmd: string, args: string[]): Promise<void> {
  let handoffId = positionals(args)[0];
  if (!handoffId && cmd === "switch") {
    await handleTui(args);
    return;
  }

  if (!handoffId) {
    throw new Error(`Missing handoff id for ${cmd}`);
  }

  const config = loadConfig();
  const workspaceId = resolveWorkspace(readOption(args, "--workspace"), config);
  const client = createBackendClientFromConfig(config);

  if (cmd === "switch" && handoffId === "-") {
    const rows = await client.listHandoffs(workspaceId);
    const active = rows.filter((r) => {
      const group = groupHandoffStatus(r.status);
      return group === "running" || group === "idle" || group === "queued";
    });
    const sorted = active.sort((a, b) => b.updatedAt - a.updatedAt);
    const target = sorted[0];
    if (!target) {
      throw new Error("No active handoffs to switch to");
    }
    handoffId = target.handoffId;
  }

  if (cmd === "switch") {
    const result = await client.switchHandoff(workspaceId, handoffId);
    console.log(`cd ${result.switchTarget}`);
    return;
  }

  if (cmd === "attach") {
    const result = await client.attachHandoff(workspaceId, handoffId);
    console.log(`target=${result.target} session=${result.sessionId ?? "none"}`);
    return;
  }

  if (cmd === "merge" || cmd === "archive") {
    await client.runAction(workspaceId, handoffId, cmd);
    console.log("ok");
    return;
  }

  throw new Error(`Unsupported action: ${cmd}`);
}

async function main(): Promise<void> {
  await ensureBunRuntime();

  const args = process.argv.slice(2);
  const cmd = args[0];
  const rest = args.slice(1);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printUsage();
    return;
  }

  if (cmd === "backend") {
    await handleBackend(rest);
    return;
  }

  const config = loadConfig();
  await ensureBackendRunning(config);

  if (!cmd || cmd.startsWith("--")) {
    await handleTui(args);
    return;
  }

  if (cmd === "workspace") {
    await handleWorkspace(rest);
    return;
  }

  if (cmd === "create") {
    await handleCreate(rest);
    return;
  }

  if (cmd === "list") {
    await handleList(rest);
    return;
  }

  if (cmd === "tui") {
    await handleTui(rest);
    return;
  }

  if (cmd === "status") {
    await handleStatus(rest);
    return;
  }

  if (cmd === "history") {
    await handleHistory(rest);
    return;
  }

  if (cmd === "push") {
    await handlePush(rest);
    return;
  }

  if (cmd === "sync") {
    await handleSync(rest);
    return;
  }

  if (cmd === "kill") {
    await handleKill(rest);
    return;
  }

  if (cmd === "prune") {
    await handlePrune(rest);
    return;
  }

  if (cmd === "statusline") {
    await handleStatusline(rest);
    return;
  }

  if (cmd === "db") {
    await handleDb(rest);
    return;
  }

  if (["switch", "attach", "merge", "archive"].includes(cmd)) {
    await handleSwitchLike(cmd, rest);
    return;
  }

  printUsage();
  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(msg);
  process.exit(1);
});
