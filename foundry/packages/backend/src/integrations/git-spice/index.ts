import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 2 * 60_000;

interface SpiceCommand {
  command: string;
  prefix: string[];
}

export interface SpiceStackEntry {
  branchName: string;
  parentBranch: string | null;
}

function spiceCommands(): SpiceCommand[] {
  const explicit = process.env.HF_GIT_SPICE_BIN?.trim();
  const list: SpiceCommand[] = [];
  if (explicit) {
    list.push({ command: explicit, prefix: [] });
  }
  list.push({ command: "git-spice", prefix: [] });
  list.push({ command: "git", prefix: ["spice"] });
  return list;
}

function commandLabel(cmd: SpiceCommand): string {
  return [cmd.command, ...cmd.prefix].join(" ");
}

function looksMissing(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.includes("ENOENT") || detail.includes("not a git command") || detail.includes("command not found");
}

async function tryRun(repoPath: string, cmd: SpiceCommand, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(cmd.command, [...cmd.prefix, ...args], {
    cwd: repoPath,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 8,
    env: {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

async function pickCommand(repoPath: string): Promise<SpiceCommand | null> {
  for (const candidate of spiceCommands()) {
    try {
      await tryRun(repoPath, candidate, ["--help"]);
      return candidate;
    } catch (error) {
      if (looksMissing(error)) {
        continue;
      }
    }
  }
  return null;
}

async function runSpice(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const cmd = await pickCommand(repoPath);
  if (!cmd) {
    throw new Error("git-spice is not available (set HF_GIT_SPICE_BIN or install git-spice)");
  }
  return await tryRun(repoPath, cmd, args);
}

function parseLogJson(stdout: string): SpiceStackEntry[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const entries: SpiceStackEntry[] = [];

  // `git-spice log ... --json` prints one JSON object per line.
  for (const line of trimmed.split("\n")) {
    const raw = line.trim();
    if (!raw.startsWith("{")) {
      continue;
    }
    try {
      const value = JSON.parse(raw) as {
        name?: string;
        branch?: string;
        parent?: string | null;
        parentBranch?: string | null;
      };
      const branchName = (value.name ?? value.branch ?? "").trim();
      if (!branchName) {
        continue;
      }
      const parentRaw = value.parent ?? value.parentBranch ?? null;
      const parentBranch = parentRaw ? parentRaw.trim() || null : null;
      entries.push({ branchName, parentBranch });
    } catch {
      continue;
    }
  }

  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.branchName)) {
      return false;
    }
    seen.add(entry.branchName);
    return true;
  });
}

async function runFallbacks(repoPath: string, commands: string[][], errorContext: string): Promise<void> {
  const failures: string[] = [];
  for (const args of commands) {
    try {
      await runSpice(repoPath, args);
      return;
    } catch (error) {
      failures.push(`${args.join(" ")} :: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${errorContext}. attempts=${failures.join(" | ")}`);
}

export async function gitSpiceAvailable(repoPath: string): Promise<boolean> {
  return (await pickCommand(repoPath)) !== null;
}

export async function gitSpiceListStack(repoPath: string): Promise<SpiceStackEntry[]> {
  try {
    const { stdout } = await runSpice(repoPath, ["log", "short", "--all", "--json", "--no-cr-status", "--no-prompt"]);
    return parseLogJson(stdout);
  } catch {
    return [];
  }
}

export async function gitSpiceSyncRepo(repoPath: string): Promise<void> {
  await runFallbacks(
    repoPath,
    [
      ["repo", "sync", "--restack", "--no-prompt"],
      ["repo", "sync", "--restack"],
      ["repo", "sync"],
    ],
    "git-spice repo sync failed",
  );
}

export async function gitSpiceRestackRepo(repoPath: string): Promise<void> {
  await runFallbacks(
    repoPath,
    [
      ["repo", "restack", "--no-prompt"],
      ["repo", "restack"],
    ],
    "git-spice repo restack failed",
  );
}

export async function gitSpiceRestackSubtree(repoPath: string, branchName: string): Promise<void> {
  await runFallbacks(
    repoPath,
    [
      ["upstack", "restack", "--branch", branchName, "--no-prompt"],
      ["upstack", "restack", "--branch", branchName],
      ["branch", "restack", "--branch", branchName, "--no-prompt"],
      ["branch", "restack", "--branch", branchName],
    ],
    `git-spice restack subtree failed for ${branchName}`,
  );
}

export async function gitSpiceRebaseBranch(repoPath: string, branchName: string): Promise<void> {
  await runFallbacks(
    repoPath,
    [
      ["branch", "restack", "--branch", branchName, "--no-prompt"],
      ["branch", "restack", "--branch", branchName],
    ],
    `git-spice branch restack failed for ${branchName}`,
  );
}

export async function gitSpiceReparentBranch(repoPath: string, branchName: string, parentBranch: string): Promise<void> {
  await runFallbacks(
    repoPath,
    [
      ["upstack", "onto", "--branch", branchName, parentBranch, "--no-prompt"],
      ["upstack", "onto", "--branch", branchName, parentBranch],
      ["branch", "onto", "--branch", branchName, parentBranch, "--no-prompt"],
      ["branch", "onto", "--branch", branchName, parentBranch],
    ],
    `git-spice reparent failed for ${branchName} -> ${parentBranch}`,
  );
}

export async function gitSpiceTrackBranch(repoPath: string, branchName: string, parentBranch: string): Promise<void> {
  await runFallbacks(
    repoPath,
    [
      ["branch", "track", branchName, "--base", parentBranch, "--no-prompt"],
      ["branch", "track", branchName, "--base", parentBranch],
    ],
    `git-spice track failed for ${branchName}`,
  );
}

export function normalizeBaseBranchName(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) {
    return "main";
  }
  return trimmed.startsWith("origin/") ? trimmed.slice("origin/".length) : trimmed;
}

export function describeSpiceCommandForLogs(repoPath: string): Promise<string | null> {
  return pickCommand(repoPath).then((cmd) => (cmd ? commandLabel(cmd) : null));
}
