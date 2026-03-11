import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_VALIDATE_REMOTE_TIMEOUT_MS = 15_000;
const DEFAULT_GIT_FETCH_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_GIT_CLONE_TIMEOUT_MS = 5 * 60_000;
const MOCK_GITHUB_PROTOCOL = "mockgithub:";

function resolveGithubToken(): string | null {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? process.env.HF_GITHUB_TOKEN ?? process.env.HF_GH_TOKEN ?? null;
  if (!token) return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

let cachedAskpassPath: string | null = null;
function ensureAskpassScript(): string {
  if (cachedAskpassPath) {
    return cachedAskpassPath;
  }

  const dir = mkdtempSync(resolve(tmpdir(), "foundry-git-askpass-"));
  const path = resolve(dir, "askpass.sh");

  // Git invokes $GIT_ASKPASS with the prompt string as argv[1]. Provide both username and password.
  // We avoid embedding the token in this file; it is read from env at runtime.
  const content = [
    "#!/bin/sh",
    'prompt="$1"',
    // Prefer GH_TOKEN/GITHUB_TOKEN but support HF_* aliases too.
    'token="${GH_TOKEN:-${GITHUB_TOKEN:-${HF_GITHUB_TOKEN:-${HF_GH_TOKEN:-}}}}"',
    'case "$prompt" in',
    '  *Username*) echo "x-access-token" ;;',
    '  *Password*) echo "$token" ;;',
    '  *) echo "" ;;',
    "esac",
    "",
  ].join("\n");

  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o700);
  cachedAskpassPath = path;
  return path;
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.GIT_TERMINAL_PROMPT = "0";

  const token = resolveGithubToken();
  if (token) {
    env.GIT_ASKPASS = ensureAskpassScript();
    // Some tooling expects these vars; keep them aligned.
    env.GITHUB_TOKEN = env.GITHUB_TOKEN || token;
    env.GH_TOKEN = env.GH_TOKEN || token;
  }

  return env;
}

export interface BranchSnapshot {
  branchName: string;
  commitSha: string;
}

interface MockRemoteDescriptor {
  owner: string;
  repo: string;
  barePath: string;
  bareFileUrl: string;
}

function resolveMockRemote(remoteUrl: string): MockRemoteDescriptor | null {
  try {
    const url = new URL(remoteUrl);
    if (url.protocol !== MOCK_GITHUB_PROTOCOL) {
      return null;
    }

    const owner = url.hostname.trim();
    const repo = url.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/i, "")
      .trim();
    if (!owner || !repo) {
      return null;
    }

    const barePath = resolve(homedir(), ".local", "share", "sandbox-agent-foundry", "mock-remotes", owner, `${repo}.git`);
    return {
      owner,
      repo,
      barePath,
      bareFileUrl: pathToFileURL(barePath).toString(),
    };
  } catch {
    return null;
  }
}

async function ensureMockRemote(remoteUrl: string): Promise<MockRemoteDescriptor | null> {
  const descriptor = resolveMockRemote(remoteUrl);
  if (!descriptor) {
    return null;
  }

  if (existsSync(descriptor.barePath)) {
    return descriptor;
  }

  mkdirSync(dirname(descriptor.barePath), { recursive: true });

  const tempRepoPath = mkdtempSync(resolve(tmpdir(), `foundry-mock-${descriptor.owner}-${descriptor.repo}-`));
  try {
    await execFileAsync("git", ["init", "--bare", descriptor.barePath], {
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_GIT_CLONE_TIMEOUT_MS,
      env: gitEnv(),
    });
    await execFileAsync("git", ["init", "-b", "main", tempRepoPath], {
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_GIT_CLONE_TIMEOUT_MS,
      env: gitEnv(),
    });

    mkdirSync(resolve(tempRepoPath, "src"), { recursive: true });
    writeFileSync(
      resolve(tempRepoPath, "README.md"),
      [`# ${descriptor.owner}/${descriptor.repo}`, "", "Mock imported repository for Foundry onboarding flows."].join("\n"),
      "utf8",
    );
    writeFileSync(
      resolve(tempRepoPath, "src", "index.ts"),
      [
        `export const repositoryId = ${JSON.stringify(`${descriptor.owner}/${descriptor.repo}`)};`,
        "",
        "export function boot() {",
        `  return ${JSON.stringify(`hello from ${descriptor.owner}/${descriptor.repo}`)};`,
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    await execFileAsync("git", ["-C", tempRepoPath, "add", "."], {
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_GIT_CLONE_TIMEOUT_MS,
      env: gitEnv(),
    });
    await execFileAsync(
      "git",
      ["-C", tempRepoPath, "-c", "user.name=Sandbox Agent Foundry", "-c", "user.email=foundry-mock@sandboxagent.dev", "commit", "-m", "Initial commit"],
      {
        maxBuffer: 1024 * 1024,
        timeout: DEFAULT_GIT_CLONE_TIMEOUT_MS,
        env: gitEnv(),
      },
    );
    await execFileAsync("git", ["-C", tempRepoPath, "remote", "add", "origin", descriptor.barePath], {
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_GIT_CLONE_TIMEOUT_MS,
      env: gitEnv(),
    });
    await execFileAsync("git", ["-C", tempRepoPath, "push", "-u", "origin", "main"], {
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_GIT_CLONE_TIMEOUT_MS,
      env: gitEnv(),
    });
  } catch (error) {
    rmSync(descriptor.barePath, { force: true, recursive: true });
    throw error;
  } finally {
    rmSync(tempRepoPath, { force: true, recursive: true });
  }

  return descriptor;
}

export async function fetch(repoPath: string): Promise<void> {
  await execFileAsync("git", ["-C", repoPath, "fetch", "--prune"], {
    timeout: DEFAULT_GIT_FETCH_TIMEOUT_MS,
    env: gitEnv(),
  });
}

export async function revParse(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", ref], { env: gitEnv() });
  return stdout.trim();
}

export async function validateRemote(remoteUrl: string): Promise<void> {
  const remote = remoteUrl.trim();
  if (!remote) {
    throw new Error("remoteUrl is required");
  }
  if (await ensureMockRemote(remote)) {
    return;
  }
  try {
    await execFileAsync("git", ["ls-remote", "--exit-code", remote, "HEAD"], {
      // This command does not need repo context. Running from a neutral directory
      // avoids inheriting broken worktree .git indirection inside dev containers.
      cwd: tmpdir(),
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_GIT_VALIDATE_REMOTE_TIMEOUT_MS,
      env: gitEnv(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git remote validation failed: ${detail}`);
  }
}

function isGitRepo(path: string): boolean {
  return existsSync(resolve(path, ".git"));
}

export async function ensureCloned(remoteUrl: string, targetPath: string): Promise<void> {
  const remote = remoteUrl.trim();
  if (!remote) {
    throw new Error("remoteUrl is required");
  }
  const mockRemote = await ensureMockRemote(remote);
  const cloneRemote = mockRemote?.bareFileUrl ?? remote;

  if (existsSync(targetPath)) {
    if (!isGitRepo(targetPath)) {
      throw new Error(`targetPath exists but is not a git repo: ${targetPath}`);
    }

    // Keep origin aligned with the configured remote URL.
    await execFileAsync("git", ["-C", targetPath, "remote", "set-url", "origin", cloneRemote], {
      maxBuffer: 1024 * 1024,
      timeout: DEFAULT_GIT_FETCH_TIMEOUT_MS,
      env: gitEnv(),
    });
    await fetch(targetPath);
    return;
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  await execFileAsync("git", ["clone", cloneRemote, targetPath], {
    maxBuffer: 1024 * 1024 * 8,
    timeout: DEFAULT_GIT_CLONE_TIMEOUT_MS,
    env: gitEnv(),
  });
  await fetch(targetPath);
}

export async function remoteDefaultBaseRef(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "symbolic-ref", "refs/remotes/origin/HEAD"], { env: gitEnv() });
    const ref = stdout.trim(); // refs/remotes/origin/main
    const match = ref.match(/^refs\/remotes\/(.+)$/);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // fall through
  }

  const candidates = ["origin/main", "origin/master", "main", "master"];
  for (const ref of candidates) {
    try {
      await execFileAsync("git", ["-C", repoPath, "rev-parse", "--verify", ref], { env: gitEnv() });
      return ref;
    } catch {
      continue;
    }
  }
  return "origin/main";
}

export async function listRemoteBranches(repoPath: string): Promise<BranchSnapshot[]> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/remotes/origin"], {
    maxBuffer: 1024 * 1024,
    env: gitEnv(),
  });

  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [refName, commitSha] = line.trim().split(/\s+/, 2);
      const short = (refName ?? "").trim();
      const branchName = short.replace(/^origin\//, "");
      return { branchName, commitSha: commitSha ?? "" };
    })
    .filter((row) => row.branchName.length > 0 && row.branchName !== "HEAD" && row.branchName !== "origin" && row.commitSha.length > 0);
}

async function remoteBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", `refs/remotes/origin/${branchName}`], { env: gitEnv() });
    return true;
  } catch {
    return false;
  }
}

export async function ensureRemoteBranch(repoPath: string, branchName: string): Promise<void> {
  await fetch(repoPath);
  if (await remoteBranchExists(repoPath, branchName)) {
    return;
  }

  const baseRef = await remoteDefaultBaseRef(repoPath);
  await execFileAsync("git", ["-C", repoPath, "push", "origin", `${baseRef}:refs/heads/${branchName}`], {
    maxBuffer: 1024 * 1024 * 2,
    env: gitEnv(),
  });
  await fetch(repoPath);
}

export async function diffStatForBranch(repoPath: string, branchName: string): Promise<string> {
  try {
    const baseRef = await remoteDefaultBaseRef(repoPath);
    const headRef = `origin/${branchName}`;
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "diff", "--shortstat", `${baseRef}...${headRef}`], {
      maxBuffer: 1024 * 1024,
      env: gitEnv(),
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return "+0/-0";
    }
    const insertMatch = trimmed.match(/(\d+)\s+insertion/);
    const deleteMatch = trimmed.match(/(\d+)\s+deletion/);
    const insertions = insertMatch ? insertMatch[1] : "0";
    const deletions = deleteMatch ? deleteMatch[1] : "0";
    return `+${insertions}/-${deletions}`;
  } catch {
    return "+0/-0";
  }
}

export async function conflictsWithMain(repoPath: string, branchName: string): Promise<boolean> {
  try {
    const baseRef = await remoteDefaultBaseRef(repoPath);
    const headRef = `origin/${branchName}`;
    // Use merge-tree (git 2.38+) for a clean conflict check.
    try {
      await execFileAsync("git", ["-C", repoPath, "merge-tree", "--write-tree", "--no-messages", baseRef, headRef], { env: gitEnv() });
      // If merge-tree exits 0, no conflicts. Non-zero exit means conflicts.
      return false;
    } catch {
      // merge-tree exits non-zero when there are conflicts
      return true;
    }
  } catch {
    return false;
  }
}

export async function getOriginOwner(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "remote", "get-url", "origin"], { env: gitEnv() });
    const url = stdout.trim();
    // Handle SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/[:\/]([^\/]+)\/[^\/]+(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1] ?? "";
    }
    // Handle HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/\/\/[^\/]+\/([^\/]+)\//);
    if (httpsMatch) {
      return httpsMatch[1] ?? "";
    }
    return "";
  } catch {
    return "";
  }
}
