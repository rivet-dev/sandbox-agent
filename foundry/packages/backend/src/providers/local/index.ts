import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { InMemorySessionPersistDriver, SandboxAgent } from "sandbox-agent";
import type {
  AgentEndpoint,
  AttachTarget,
  AttachTargetRequest,
  CreateSandboxRequest,
  DestroySandboxRequest,
  EnsureAgentRequest,
  ExecuteSandboxCommandRequest,
  ExecuteSandboxCommandResult,
  ProviderCapabilities,
  ReleaseSandboxRequest,
  ResumeSandboxRequest,
  SandboxHandle,
  SandboxHealth,
  SandboxHealthRequest,
  SandboxProvider,
} from "../provider-api/index.js";
import type { GitDriver } from "../../driver.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SANDBOX_AGENT_PORT = 2468;

export interface LocalProviderConfig {
  rootDir?: string;
  sandboxAgentPort?: number;
}

function expandHome(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return value;
}

async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoPath, "show-ref", "--verify", `refs/remotes/origin/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

async function checkoutBranch(repoPath: string, branchName: string, git: GitDriver): Promise<void> {
  await git.fetch(repoPath);
  const targetRef = (await branchExists(repoPath, branchName)) ? `origin/${branchName}` : await git.remoteDefaultBaseRef(repoPath);
  await execFileAsync("git", ["-C", repoPath, "checkout", "-B", branchName, targetRef], {
    env: process.env as Record<string, string>,
  });
}

export class LocalProvider implements SandboxProvider {
  private sdkPromise: Promise<SandboxAgent> | null = null;

  constructor(
    private readonly config: LocalProviderConfig,
    private readonly git: GitDriver,
  ) {}

  private rootDir(): string {
    return expandHome(this.config.rootDir?.trim() || "~/.local/share/foundry/local-sandboxes");
  }

  private sandboxRoot(workspaceId: string, sandboxId: string): string {
    return resolve(this.rootDir(), workspaceId, sandboxId);
  }

  private repoDir(workspaceId: string, sandboxId: string): string {
    return resolve(this.sandboxRoot(workspaceId, sandboxId), "repo");
  }

  private sandboxHandle(workspaceId: string, sandboxId: string, repoDir: string): SandboxHandle {
    return {
      sandboxId,
      switchTarget: `local://${repoDir}`,
      metadata: {
        cwd: repoDir,
        repoDir,
      },
    };
  }

  private async sandboxAgent(): Promise<SandboxAgent> {
    if (!this.sdkPromise) {
      const sandboxAgentHome = resolve(this.rootDir(), ".sandbox-agent-home");
      mkdirSync(sandboxAgentHome, { recursive: true });
      const spawnHome = process.env.HOME?.trim() || sandboxAgentHome;
      this.sdkPromise = SandboxAgent.start({
        persist: new InMemorySessionPersistDriver(),
        spawn: {
          enabled: true,
          host: "127.0.0.1",
          port: this.config.sandboxAgentPort ?? DEFAULT_SANDBOX_AGENT_PORT,
          log: "silent",
          env: {
            HOME: spawnHome,
            ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
            ...(process.env.CLAUDE_API_KEY ? { CLAUDE_API_KEY: process.env.CLAUDE_API_KEY } : {}),
            ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}),
            ...(process.env.CODEX_API_KEY ? { CODEX_API_KEY: process.env.CODEX_API_KEY } : {}),
            ...(process.env.GH_TOKEN ? { GH_TOKEN: process.env.GH_TOKEN } : {}),
            ...(process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : {}),
          },
        },
      }).then(async (sdk) => {
        for (const agentName of ["claude", "codex"] as const) {
          try {
            const agent = await sdk.getAgent(agentName, { config: true });
            if (!agent.installed) {
              await sdk.installAgent(agentName);
            }
          } catch {
            // The local provider can still function if the agent is already available
            // through the user's PATH or the install check is unsupported.
          }
        }
        return sdk;
      });
    }
    return this.sdkPromise;
  }

  id() {
    return "local" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      remote: false,
      supportsSessionReuse: true,
    };
  }

  async validateConfig(input: unknown): Promise<Record<string, unknown>> {
    return (input as Record<string, unknown> | undefined) ?? {};
  }

  async createSandbox(req: CreateSandboxRequest): Promise<SandboxHandle> {
    const sandboxId = req.taskId || `local-${randomUUID()}`;
    const repoDir = this.repoDir(req.workspaceId, sandboxId);
    mkdirSync(dirname(repoDir), { recursive: true });
    await this.git.ensureCloned(req.repoRemote, repoDir);
    await checkoutBranch(repoDir, req.branchName, this.git);
    return this.sandboxHandle(req.workspaceId, sandboxId, repoDir);
  }

  async resumeSandbox(req: ResumeSandboxRequest): Promise<SandboxHandle> {
    const repoDir = this.repoDir(req.workspaceId, req.sandboxId);
    if (!existsSync(repoDir)) {
      throw new Error(`local sandbox repo is missing: ${repoDir}`);
    }
    return this.sandboxHandle(req.workspaceId, req.sandboxId, repoDir);
  }

  async destroySandbox(req: DestroySandboxRequest): Promise<void> {
    rmSync(this.sandboxRoot(req.workspaceId, req.sandboxId), {
      force: true,
      recursive: true,
    });
  }

  async releaseSandbox(_req: ReleaseSandboxRequest): Promise<void> {
    // Local sandboxes stay warm on disk to preserve session state and repo context.
  }

  async ensureSandboxAgent(_req: EnsureAgentRequest): Promise<AgentEndpoint> {
    const sdk = await this.sandboxAgent();
    const { baseUrl, token } = sdk as unknown as {
      baseUrl?: string;
      token?: string;
    };
    if (!baseUrl) {
      throw new Error("sandbox-agent baseUrl is unavailable");
    }
    return token ? { endpoint: baseUrl, token } : { endpoint: baseUrl };
  }

  async health(req: SandboxHealthRequest): Promise<SandboxHealth> {
    try {
      const repoDir = this.repoDir(req.workspaceId, req.sandboxId);
      if (!existsSync(repoDir)) {
        return {
          status: "down",
          message: "local sandbox repo is missing",
        };
      }
      const sdk = await this.sandboxAgent();
      const health = await sdk.getHealth();
      return {
        status: health.status === "ok" ? "healthy" : "degraded",
        message: health.status,
      };
    } catch (error) {
      return {
        status: "down",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async attachTarget(req: AttachTargetRequest): Promise<AttachTarget> {
    return { target: this.repoDir(req.workspaceId, req.sandboxId) };
  }

  async executeCommand(req: ExecuteSandboxCommandRequest): Promise<ExecuteSandboxCommandResult> {
    const cwd = this.repoDir(req.workspaceId, req.sandboxId);
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-lc", req.command], {
        cwd,
        env: process.env as Record<string, string>,
        maxBuffer: 1024 * 1024 * 16,
      });
      return {
        exitCode: 0,
        result: [stdout, stderr].filter(Boolean).join(""),
      };
    } catch (error) {
      const detail = error as { stdout?: string; stderr?: string; code?: number };
      return {
        exitCode: typeof detail.code === "number" ? detail.code : 1,
        result: [detail.stdout, detail.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join(""),
      };
    }
  }
}
