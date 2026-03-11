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
import type { DaytonaDriver } from "../../driver.js";
import { Image } from "@daytonaio/sdk";

export interface DaytonaProviderConfig {
  endpoint?: string;
  apiKey?: string;
  image: string;
  target?: string;
  /**
   * Auto-stop interval in minutes. If omitted, Daytona's default applies.
   * Set to `0` to disable auto-stop.
   */
  autoStopInterval?: number;
}

export class DaytonaProvider implements SandboxProvider {
  constructor(
    private readonly config: DaytonaProviderConfig,
    private readonly daytona?: DaytonaDriver,
  ) {}

  private static readonly SANDBOX_AGENT_PORT = 2468;
  private static readonly SANDBOX_AGENT_VERSION = "0.3.0";
  private static readonly DEFAULT_ACP_REQUEST_TIMEOUT_MS = 120_000;
  private static readonly AGENT_IDS = ["codex", "claude"] as const;
  private static readonly PASSTHROUGH_ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "CLAUDE_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENCODE_API_KEY",
    "CEREBRAS_API_KEY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ] as const;

  private getRequestTimeoutMs(): number {
    const parsed = Number(process.env.HF_DAYTONA_REQUEST_TIMEOUT_MS ?? "120000");
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 120_000;
    }
    return Math.floor(parsed);
  }

  private getAcpRequestTimeoutMs(): number {
    const parsed = Number(process.env.HF_SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS ?? DaytonaProvider.DEFAULT_ACP_REQUEST_TIMEOUT_MS.toString());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DaytonaProvider.DEFAULT_ACP_REQUEST_TIMEOUT_MS;
    }
    return Math.floor(parsed);
  }

  private async withTimeout<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const timeoutMs = this.getRequestTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`daytona ${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private getClient() {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) {
      return undefined;
    }
    const endpoint = this.config.endpoint?.trim();

    return this.daytona?.createClient({
      ...(endpoint ? { apiUrl: endpoint } : {}),
      apiKey,
      target: this.config.target,
    });
  }

  private requireClient() {
    const client = this.getClient();
    if (client) {
      return client;
    }

    if (!this.daytona) {
      throw new Error("daytona provider requires backend daytona driver");
    }

    throw new Error(
      "daytona provider is not configured: missing apiKey. " +
        "Set HF_DAYTONA_API_KEY (or DAYTONA_API_KEY). " +
        "Optionally set HF_DAYTONA_ENDPOINT (or DAYTONA_ENDPOINT).",
    );
  }

  private async ensureStarted(sandboxId: string): Promise<void> {
    const client = this.requireClient();

    const sandbox = await this.withTimeout("get sandbox", () => client.getSandbox(sandboxId));
    const state = String(sandbox.state ?? "unknown").toLowerCase();
    if (state === "started" || state === "running") {
      return;
    }

    // If the sandbox is stopped (or any non-started state), try starting it.
    // Daytona preserves the filesystem across stop/start, which is what we rely on for faster git setup.
    await this.withTimeout("start sandbox", () => client.startSandbox(sandboxId, 60));
  }

  private buildEnvVars(): Record<string, string> {
    const envVars: Record<string, string> = {};

    for (const key of DaytonaProvider.PASSTHROUGH_ENV_KEYS) {
      const value = process.env[key];
      if (value) {
        envVars[key] = value;
      }
    }

    return envVars;
  }

  private buildSnapshotImage() {
    // Use Daytona image build + snapshot caching so base tooling (git + sandbox-agent)
    // is prepared once and reused for subsequent sandboxes.
    return Image.base(this.config.image).runCommands(
      "apt-get update && apt-get install -y curl ca-certificates git openssh-client nodejs npm",
      `curl -fsSL https://releases.rivet.dev/sandbox-agent/${DaytonaProvider.SANDBOX_AGENT_VERSION}/install.sh | sh`,
      `bash -lc 'export PATH="$HOME/.local/bin:$PATH"; sandbox-agent install-agent codex || true; sandbox-agent install-agent claude || true'`,
    );
  }

  private async runCheckedCommand(sandboxId: string, command: string, label: string): Promise<void> {
    const client = this.requireClient();

    const result = await this.withTimeout(`execute command (${label})`, () => client.executeCommand(sandboxId, command));
    if (result.exitCode !== 0) {
      throw new Error(`daytona ${label} failed (${result.exitCode}): ${result.result}`);
    }
  }

  id() {
    return "daytona" as const;
  }

  capabilities(): ProviderCapabilities {
    return {
      remote: true,
      supportsSessionReuse: true,
    };
  }

  async validateConfig(input: unknown): Promise<Record<string, unknown>> {
    return (input as Record<string, unknown> | undefined) ?? {};
  }

  async createSandbox(req: CreateSandboxRequest): Promise<SandboxHandle> {
    const client = this.requireClient();
    const emitDebug = req.debug ?? (() => {});

    emitDebug("daytona.createSandbox.start", {
      workspaceId: req.workspaceId,
      repoId: req.repoId,
      taskId: req.taskId,
      branchName: req.branchName,
    });

    const createStartedAt = Date.now();
    const sandbox = await this.withTimeout("create sandbox", () =>
      client.createSandbox({
        image: this.buildSnapshotImage(),
        envVars: this.buildEnvVars(),
        labels: {
          "foundry.workspace": req.workspaceId,
          "foundry.task": req.taskId,
          "foundry.repo_id": req.repoId,
          "foundry.repo_remote": req.repoRemote,
          "foundry.branch": req.branchName,
        },
        autoStopInterval: this.config.autoStopInterval,
      }),
    );
    emitDebug("daytona.createSandbox.created", {
      sandboxId: sandbox.id,
      durationMs: Date.now() - createStartedAt,
      state: sandbox.state ?? null,
    });

    const repoDir = `/home/daytona/foundry/${req.workspaceId}/${req.repoId}/${req.taskId}/repo`;

    // Prepare a working directory for the agent. This must succeed for the task to work.
    const installStartedAt = Date.now();
    await this.runCheckedCommand(
      sandbox.id,
      [
        "bash",
        "-lc",
        `'set -euo pipefail; export DEBIAN_FRONTEND=noninteractive; if command -v git >/dev/null 2>&1 && command -v npx >/dev/null 2>&1; then exit 0; fi; apt-get update -y >/tmp/apt-update.log 2>&1; apt-get install -y git openssh-client ca-certificates nodejs npm >/tmp/apt-install.log 2>&1'`,
      ].join(" "),
      "install git + node toolchain",
    );
    emitDebug("daytona.createSandbox.install_toolchain.done", {
      sandboxId: sandbox.id,
      durationMs: Date.now() - installStartedAt,
    });

    const cloneStartedAt = Date.now();
    await this.runCheckedCommand(
      sandbox.id,
      [
        "bash",
        "-lc",
        `${JSON.stringify(
          [
            "set -euo pipefail",
            "export GIT_TERMINAL_PROMPT=0",
            "export GIT_ASKPASS=/bin/echo",
            `rm -rf "${repoDir}"`,
            `mkdir -p "${repoDir}"`,
            `rmdir "${repoDir}"`,
            // Clone without embedding credentials. Auth for pushing is configured by the agent at runtime.
            `git clone "${req.repoRemote}" "${repoDir}"`,
            `cd "${repoDir}"`,
            `git fetch origin --prune`,
            // The task branch may not exist remotely yet (agent push creates it). Base off current branch (default branch).
            `if git show-ref --verify --quiet "refs/remotes/origin/${req.branchName}"; then git checkout -B "${req.branchName}" "origin/${req.branchName}"; else git checkout -B "${req.branchName}" "$(git branch --show-current 2>/dev/null || echo main)"; fi`,
            `git config user.email "foundry@local" >/dev/null 2>&1 || true`,
            `git config user.name "Foundry" >/dev/null 2>&1 || true`,
          ].join("; "),
        )}`,
      ].join(" "),
      "clone repo",
    );
    emitDebug("daytona.createSandbox.clone_repo.done", {
      sandboxId: sandbox.id,
      durationMs: Date.now() - cloneStartedAt,
    });

    return {
      sandboxId: sandbox.id,
      switchTarget: `daytona://${sandbox.id}`,
      metadata: {
        endpoint: this.config.endpoint ?? null,
        image: this.config.image,
        snapshot: sandbox.snapshot ?? null,
        remote: true,
        state: sandbox.state ?? null,
        cwd: repoDir,
      },
    };
  }

  async resumeSandbox(req: ResumeSandboxRequest): Promise<SandboxHandle> {
    const client = this.requireClient();

    await this.ensureStarted(req.sandboxId);

    // Reconstruct cwd from sandbox labels written at create time.
    const info = await this.withTimeout("resume get sandbox", () => client.getSandbox(req.sandboxId));
    const labels = info.labels ?? {};
    const workspaceId = labels["foundry.workspace"] ?? req.workspaceId;
    const repoId = labels["foundry.repo_id"] ?? "";
    const taskId = labels["foundry.task"] ?? "";
    const cwd = repoId && taskId ? `/home/daytona/foundry/${workspaceId}/${repoId}/${taskId}/repo` : null;

    return {
      sandboxId: req.sandboxId,
      switchTarget: `daytona://${req.sandboxId}`,
      metadata: {
        resumed: true,
        endpoint: this.config.endpoint ?? null,
        ...(cwd ? { cwd } : {}),
      },
    };
  }

  async destroySandbox(_req: DestroySandboxRequest): Promise<void> {
    const client = this.getClient();
    if (!client) {
      return;
    }

    try {
      await this.withTimeout("delete sandbox", () => client.deleteSandbox(_req.sandboxId));
    } catch (error) {
      // Ignore not-found style cleanup failures.
      const text = error instanceof Error ? error.message : String(error);
      if (text.toLowerCase().includes("not found")) {
        return;
      }
      throw error;
    }
  }

  async releaseSandbox(req: ReleaseSandboxRequest): Promise<void> {
    const client = this.getClient();
    if (!client) {
      return;
    }

    try {
      await this.withTimeout("stop sandbox", () => client.stopSandbox(req.sandboxId, 60));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.toLowerCase().includes("not found")) {
        return;
      }
      throw error;
    }
  }

  async ensureSandboxAgent(req: EnsureAgentRequest): Promise<AgentEndpoint> {
    const client = this.requireClient();
    const acpRequestTimeoutMs = this.getAcpRequestTimeoutMs();

    await this.ensureStarted(req.sandboxId);

    await this.runCheckedCommand(
      req.sandboxId,
      [
        "bash",
        "-lc",
        `'set -euo pipefail; if command -v curl >/dev/null 2>&1; then exit 0; fi; export DEBIAN_FRONTEND=noninteractive; apt-get update -y >/tmp/apt-update.log 2>&1; apt-get install -y curl ca-certificates >/tmp/apt-install.log 2>&1'`,
      ].join(" "),
      "install curl",
    );

    await this.runCheckedCommand(
      req.sandboxId,
      [
        "bash",
        "-lc",
        `'set -euo pipefail; if command -v npx >/dev/null 2>&1; then exit 0; fi; export DEBIAN_FRONTEND=noninteractive; apt-get update -y >/tmp/apt-update.log 2>&1; apt-get install -y nodejs npm >/tmp/apt-install.log 2>&1'`,
      ].join(" "),
      "install node toolchain",
    );

    await this.runCheckedCommand(
      req.sandboxId,
      [
        "bash",
        "-lc",
        `'set -euo pipefail; export PATH="$HOME/.local/bin:$PATH"; if sandbox-agent --version 2>/dev/null | grep -q "${DaytonaProvider.SANDBOX_AGENT_VERSION}"; then exit 0; fi; curl -fsSL https://releases.rivet.dev/sandbox-agent/${DaytonaProvider.SANDBOX_AGENT_VERSION}/install.sh | sh'`,
      ].join(" "),
      "install sandbox-agent",
    );

    for (const agentId of DaytonaProvider.AGENT_IDS) {
      try {
        await this.runCheckedCommand(
          req.sandboxId,
          ["bash", "-lc", `'export PATH="$HOME/.local/bin:$PATH"; sandbox-agent install-agent ${agentId}'`].join(" "),
          `install agent ${agentId}`,
        );
      } catch {
        // Some sandbox-agent builds may not ship every agent plugin; treat this as best-effort.
      }
    }

    await this.runCheckedCommand(
      req.sandboxId,
      [
        "bash",
        "-lc",
        `'set -euo pipefail; export PATH="$HOME/.local/bin:$PATH"; command -v sandbox-agent >/dev/null 2>&1; if pgrep -x sandbox-agent >/dev/null; then exit 0; fi; nohup env SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=${acpRequestTimeoutMs} sandbox-agent server --no-token --host 0.0.0.0 --port ${DaytonaProvider.SANDBOX_AGENT_PORT} >/tmp/sandbox-agent.log 2>&1 &'`,
      ].join(" "),
      "start sandbox-agent",
    );

    await this.runCheckedCommand(
      req.sandboxId,
      [
        "bash",
        "-lc",
        `'for i in $(seq 1 45); do curl -fsS "http://127.0.0.1:${DaytonaProvider.SANDBOX_AGENT_PORT}/v1/health" >/dev/null && exit 0; sleep 1; done; echo "sandbox-agent failed to become healthy" >&2; tail -n 80 /tmp/sandbox-agent.log >&2; exit 1'`,
      ].join(" "),
      "wait for sandbox-agent health",
    );

    const preview = await this.withTimeout("get preview endpoint", () => client.getPreviewEndpoint(req.sandboxId, DaytonaProvider.SANDBOX_AGENT_PORT));

    return {
      endpoint: preview.url,
      token: preview.token,
    };
  }

  async health(req: SandboxHealthRequest): Promise<SandboxHealth> {
    const client = this.getClient();
    if (!client) {
      return {
        status: "degraded",
        message: "daytona driver not configured",
      };
    }

    try {
      const sandbox = await this.withTimeout("health get sandbox", () => client.getSandbox(req.sandboxId));
      const state = String(sandbox.state ?? "unknown");
      if (state.toLowerCase().includes("error")) {
        return {
          status: "down",
          message: `daytona sandbox in error state: ${state}`,
        };
      }
      return {
        status: "healthy",
        message: `daytona sandbox state: ${state}`,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return {
        status: "down",
        message: `daytona sandbox health check failed: ${text}`,
      };
    }
  }

  async attachTarget(req: AttachTargetRequest): Promise<AttachTarget> {
    return {
      target: `daytona://${req.sandboxId}`,
    };
  }

  async executeCommand(req: ExecuteSandboxCommandRequest): Promise<ExecuteSandboxCommandResult> {
    const client = this.requireClient();
    await this.ensureStarted(req.sandboxId);
    return await this.withTimeout(`execute command (${req.label ?? "command"})`, () => client.executeCommand(req.sandboxId, req.command));
  }
}
