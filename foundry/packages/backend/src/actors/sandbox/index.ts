import { actor } from "rivetkit";
import { e2b, sandboxActor } from "rivetkit/sandbox";
import { existsSync } from "node:fs";
import Dockerode from "dockerode";
import { SandboxAgent } from "sandbox-agent";
import { getActorRuntimeContext } from "../context.js";
import { organizationKey } from "../keys.js";
import { resolveSandboxProviderId } from "../../sandbox-config.js";

const SANDBOX_REPO_CWD = "/home/sandbox/organization/repo";
const DEFAULT_LOCAL_SANDBOX_IMAGE = "rivetdev/sandbox-agent:full";
const DEFAULT_LOCAL_SANDBOX_PORT = 2468;
const dockerClient = new Dockerode({ socketPath: "/var/run/docker.sock" });

function parseTaskSandboxKey(key: readonly string[]): { organizationId: string; taskId: string } {
  if (key.length !== 4 || key[0] !== "org" || key[2] !== "sandbox") {
    throw new Error(`Invalid task sandbox key: ${JSON.stringify(key)}`);
  }

  return {
    organizationId: key[1]!,
    taskId: key[3]!,
  };
}

function preferredDockerHost(): string {
  if (process.env.FOUNDRY_DOCKER_HOST?.trim()) {
    return process.env.FOUNDRY_DOCKER_HOST.trim();
  }

  return existsSync("/.dockerenv") ? "host.docker.internal" : "127.0.0.1";
}

function preferredPublicDockerHost(): string {
  if (process.env.FOUNDRY_PUBLIC_SANDBOX_HOST?.trim()) {
    return process.env.FOUNDRY_PUBLIC_SANDBOX_HOST.trim();
  }

  return "127.0.0.1";
}

function localSandboxAgentPort(): number {
  const raw = process.env.FOUNDRY_LOCAL_SANDBOX_PORT?.trim() ?? process.env.HF_LOCAL_SANDBOX_PORT?.trim() ?? "";
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed;
  }
  return DEFAULT_LOCAL_SANDBOX_PORT;
}

function sandboxEnvPairs(): string[] {
  const openAiApiKey = process.env.OPENAI_API_KEY;
  const entries = [
    ["ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY],
    ["CLAUDE_API_KEY", process.env.CLAUDE_API_KEY ?? process.env.ANTHROPIC_API_KEY],
    ["OPENAI_API_KEY", openAiApiKey],
    // Codex ACP prefers CODEX_API_KEY when present. In dev we want that to be the
    // actual OpenAI API key, not an unrelated local Codex auth token.
    ["CODEX_API_KEY", openAiApiKey ?? process.env.CODEX_API_KEY],
    ["GH_TOKEN", process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN],
    ["GITHUB_TOKEN", process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN],
    ["E2B_API_KEY", process.env.E2B_API_KEY],
  ];

  return entries
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
    .map(([key, value]) => `${key}=${value}`);
}

function sandboxEnvObject(): Record<string, string> {
  return Object.fromEntries(
    sandboxEnvPairs().map((entry) => {
      const [key, ...rest] = entry.split("=");
      return [key!, rest.join("=")];
    }),
  );
}

function modeIdForAgent(agent?: string | null): string | null {
  switch (agent) {
    case "codex":
      return "full-access";
    case "claude":
      return "acceptEdits";
    default:
      return null;
  }
}

async function getPublishedDockerPort(sandboxId: string, containerPort: number): Promise<number> {
  const info = await dockerClient.getContainer(sandboxId).inspect();
  const hostPort = info.NetworkSettings?.Ports?.[`${containerPort}/tcp`]?.[0]?.HostPort;
  if (!hostPort) {
    throw new Error(`docker sandbox-agent port ${containerPort} is not published`);
  }
  return Number(hostPort);
}

function createLocalSandboxProvider(image: string): any {
  const agentPort = localSandboxAgentPort();
  const backendHost = preferredDockerHost();
  const publicHost = preferredPublicDockerHost();

  return {
    name: "docker",

    async create(_context: any): Promise<string> {
      const container = await dockerClient.createContainer({
        Image: image,
        Cmd: ["server", "--no-token", "--host", "0.0.0.0", "--port", String(agentPort)],
        Env: sandboxEnvPairs(),
        ExposedPorts: {
          [`${agentPort}/tcp`]: {},
        },
        HostConfig: {
          AutoRemove: true,
          PortBindings: {
            [`${agentPort}/tcp`]: [{ HostPort: "0" }],
          },
        },
      });

      await container.start();
      return container.id;
    },

    async destroy(sandboxId: string): Promise<void> {
      const container = dockerClient.getContainer(sandboxId);
      try {
        await container.stop({ t: 5 });
      } catch {}
      try {
        await container.remove({ force: true });
      } catch {}
    },

    async getUrl(sandboxId: string): Promise<string> {
      const hostPort = await getPublishedDockerPort(sandboxId, agentPort);
      return `http://${publicHost}:${hostPort}`;
    },

    async connectAgent(sandboxId: string, connectOptions: any): Promise<any> {
      const hostPort = await getPublishedDockerPort(sandboxId, agentPort);
      return await SandboxAgent.connect({
        baseUrl: `http://${backendHost}:${hostPort}`,
        ...connectOptions,
      });
    },
  };
}

function sanitizeActorResult(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "function" || value === undefined) {
    return undefined;
  }

  if (value && typeof value === "object") {
    const maybeToRecord = (value as { toRecord?: unknown }).toRecord;
    if (typeof maybeToRecord === "function") {
      return sanitizeActorResult(maybeToRecord.call(value), seen);
    }
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeActorResult(entry, seen)).filter((entry) => entry !== undefined);
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeActorResult(entry, seen);
    if (sanitized !== undefined) {
      next[key] = sanitized;
    }
  }
  return next;
}

const baseTaskSandbox = sandboxActor({
  createProvider: async (c) => {
    const { config } = getActorRuntimeContext();
    const { organizationId, taskId } = parseTaskSandboxKey(c.key);
    const organization = await c.client().organization.getOrCreate(organizationKey(organizationId), {
      createWithInput: organizationId,
    });
    const task = await organization.getTask({ organizationId, taskId });
    const sandboxProviderId = resolveSandboxProviderId(config, task.sandboxProviderId);

    if (sandboxProviderId === "e2b") {
      return e2b({
        create: () => ({
          template: config.sandboxProviders.e2b.template ?? "sandbox-agent-full-0.3.x",
          envs: sandboxEnvObject(),
        }),
        installAgents: ["claude", "codex"],
      });
    }

    return createLocalSandboxProvider(config.sandboxProviders.local.image ?? process.env.HF_LOCAL_SANDBOX_IMAGE ?? DEFAULT_LOCAL_SANDBOX_IMAGE);
  },
});

async function broadcastProcesses(c: any, actions: Record<string, (...args: any[]) => Promise<any>>): Promise<void> {
  try {
    const listed = await actions.listProcesses(c);
    c.broadcast("processesUpdated", {
      type: "processesUpdated",
      processes: listed.processes ?? [],
    });
  } catch {
    // Process broadcasts are best-effort. Callers still receive the primary action result.
  }
}

async function providerForConnection(c: any): Promise<any | null> {
  if (c.state.sandboxDestroyed || !c.state.sandboxId) {
    return null;
  }

  if (c.vars.provider) {
    return c.vars.provider;
  }

  const providerFactory = baseTaskSandbox.config.actions as Record<string, unknown>;
  void providerFactory;
  const { config } = getActorRuntimeContext();
  const { organizationId, taskId } = parseTaskSandboxKey(c.key);
  const organization = await c.client().organization.getOrCreate(organizationKey(organizationId), {
    createWithInput: organizationId,
  });
  const task = await organization.getTask({ organizationId, taskId });
  const sandboxProviderId = resolveSandboxProviderId(config, task.sandboxProviderId);

  const provider =
    sandboxProviderId === "e2b"
      ? e2b({
          create: () => ({
            template: config.sandboxProviders.e2b.template ?? "sandbox-agent-full-0.3.x",
            envs: sandboxEnvObject(),
          }),
          installAgents: ["claude", "codex"],
        })
      : createLocalSandboxProvider(config.sandboxProviders.local.image ?? process.env.HF_LOCAL_SANDBOX_IMAGE ?? DEFAULT_LOCAL_SANDBOX_IMAGE);

  c.vars.provider = provider;
  return provider;
}

const baseActions = baseTaskSandbox.config.actions as Record<string, (c: any, ...args: any[]) => Promise<any>>;

export const taskSandbox = actor({
  ...baseTaskSandbox.config,
  options: {
    ...baseTaskSandbox.config.options,
    actionTimeout: 10 * 60_000,
  },
  actions: {
    ...baseActions,
    async createSession(c: any, request: any): Promise<any> {
      const session = await baseActions.createSession(c, request);
      const sessionId = typeof request?.id === "string" && request.id.length > 0 ? request.id : session?.id;
      const modeId = modeIdForAgent(request?.agent);
      if (sessionId && modeId) {
        try {
          await baseActions.rawSendSessionMethod(c, sessionId, "session/set_mode", { modeId });
        } catch {
          // Session mode updates are best-effort.
        }
      }
      return sanitizeActorResult(session);
    },

    async resumeSession(c: any, sessionId: string): Promise<any> {
      return sanitizeActorResult(await baseActions.resumeSession(c, sessionId));
    },

    async resumeOrCreateSession(c: any, request: any): Promise<any> {
      return sanitizeActorResult(await baseActions.resumeOrCreateSession(c, request));
    },

    async getSession(c: any, sessionId: string): Promise<any> {
      return sanitizeActorResult(await baseActions.getSession(c, sessionId));
    },

    async listSessions(c: any, query?: any): Promise<any> {
      return sanitizeActorResult(await baseActions.listSessions(c, query));
    },

    async destroySession(c: any, sessionId: string): Promise<any> {
      return sanitizeActorResult(await baseActions.destroySession(c, sessionId));
    },

    async sendPrompt(c: any, request: { sessionId: string; prompt: string }): Promise<any> {
      const text = typeof request?.prompt === "string" ? request.prompt.trim() : "";
      if (!text) {
        return null;
      }

      const session = await baseActions.resumeSession(c, request.sessionId);
      if (!session || typeof session.prompt !== "function") {
        throw new Error(`session '${request.sessionId}' not found`);
      }

      return sanitizeActorResult(await session.prompt([{ type: "text", text }]));
    },

    async createProcess(c: any, request: any): Promise<any> {
      const created = await baseActions.createProcess(c, request);
      await broadcastProcesses(c, baseActions);
      return created;
    },

    async runProcess(c: any, request: any): Promise<any> {
      const result = await baseActions.runProcess(c, request);
      await broadcastProcesses(c, baseActions);
      return result;
    },

    async stopProcess(c: any, processId: string, query?: any): Promise<any> {
      const stopped = await baseActions.stopProcess(c, processId, query);
      await broadcastProcesses(c, baseActions);
      return stopped;
    },

    async killProcess(c: any, processId: string, query?: any): Promise<any> {
      const killed = await baseActions.killProcess(c, processId, query);
      await broadcastProcesses(c, baseActions);
      return killed;
    },

    async deleteProcess(c: any, processId: string): Promise<void> {
      await baseActions.deleteProcess(c, processId);
      await broadcastProcesses(c, baseActions);
    },

    async sandboxAgentConnection(c: any): Promise<{ endpoint: string; token?: string }> {
      const provider = await providerForConnection(c);
      if (!provider || !c.state.sandboxId) {
        return { endpoint: "mock://terminal-unavailable" };
      }

      try {
        return {
          endpoint: await provider.getUrl(c.state.sandboxId),
        };
      } catch {
        return { endpoint: "mock://terminal-unavailable" };
      }
    },

    async providerState(c: any): Promise<{ sandboxProviderId: "e2b" | "local"; sandboxId: string; state: string; at: number }> {
      const { config } = getActorRuntimeContext();
      const { taskId } = parseTaskSandboxKey(c.key);
      const at = Date.now();
      const sandboxProviderId = resolveSandboxProviderId(config, c.state.providerName === "e2b" ? "e2b" : c.state.providerName === "docker" ? "local" : null);

      if (c.state.sandboxDestroyed) {
        return { sandboxProviderId, sandboxId: taskId, state: "destroyed", at };
      }

      if (!c.state.sandboxId) {
        return { sandboxProviderId, sandboxId: taskId, state: "pending", at };
      }

      try {
        const health = await baseActions.getHealth(c);
        return {
          sandboxProviderId,
          sandboxId: taskId,
          state: health.status === "ok" ? "running" : "degraded",
          at,
        };
      } catch {
        return {
          sandboxProviderId,
          sandboxId: taskId,
          state: "error",
          at,
        };
      }
    },

    async repoCwd(): Promise<{ cwd: string }> {
      return { cwd: SANDBOX_REPO_CWD };
    },
  },
});

export { SANDBOX_REPO_CWD };
