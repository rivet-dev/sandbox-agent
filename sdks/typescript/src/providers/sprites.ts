import { ExecError, type SpriteConfig, SpritesClient, type ClientOptions as SpritesClientOptions } from "@fly/sprites";
import { SandboxDestroyedError } from "../client.ts";
import { SANDBOX_AGENT_INSTALL_SCRIPT } from "./shared.ts";
import type { SandboxProvider } from "./types.ts";

const DEFAULT_AGENT_PORT = 8080;
const DEFAULT_SERVICE_NAME = "sandbox-agent";
const DEFAULT_NAME_PREFIX = "sandbox-agent";
const DEFAULT_SERVICE_START_DURATION = "10m";
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_AGENT_INSTALL_TIMEOUT_MS = 10 * 60_000;
const SANDBOX_AGENT_PATH_EXPORT = 'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"';
const SANDBOX_AGENT_INSTALL_COMMAND = `command -v sandbox-agent >/dev/null 2>&1 || curl -fsSL ${SANDBOX_AGENT_INSTALL_SCRIPT} | sh`;

export interface SpritesCreateOverrides {
  name?: string;
  config?: SpriteConfig;
}

export type SpritesClientOverrides = Partial<SpritesClientOptions>;

export interface SpritesProviderOptions {
  token?: string | (() => string | Promise<string>);
  client?: SpritesClientOverrides | (() => SpritesClientOverrides | Promise<SpritesClientOverrides>);
  create?: SpritesCreateOverrides | (() => SpritesCreateOverrides | Promise<SpritesCreateOverrides>);
  env?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  installAgents?: readonly string[];
  agentPort?: number;
  serviceName?: string;
  serviceStartDuration?: string;
  namePrefix?: string;
  /** Timeout for installing the sandbox-agent binary inside the Sprite. */
  installTimeoutMs?: number;
  /** Timeout for each `install-agent` invocation inside the Sprite. */
  agentInstallTimeoutMs?: number;
}

type SpritesSandboxProvider = SandboxProvider & {
  getToken(sandboxId: string): Promise<string>;
};

interface SpritesService {
  cmd?: string;
  args?: string[];
  http_port?: number | null;
  state?: {
    status?: string;
  };
}

async function resolveValue<T>(value: T | (() => T | Promise<T>) | undefined, fallback: T): Promise<T> {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return value;
}

async function resolveToken(value: SpritesProviderOptions["token"]): Promise<string> {
  const token = await resolveValue(value, process.env.SPRITES_TOKEN ?? process.env.SPRITES_API_KEY ?? process.env.SPRITE_TOKEN ?? "");
  if (!token) {
    throw new Error("sprites provider requires a token. Set SPRITES_TOKEN (or SPRITES_API_KEY) or pass `token`.");
  }
  return token;
}

function createSpritesClient(token: string, options: SpritesClientOverrides): SpritesClient {
  return new SpritesClient(token, options);
}

function generateSpriteName(prefix: string): string {
  const suffix =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${suffix}`.toLowerCase();
}

function isSpriteNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Sprite not found:");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildServiceCommand(env: Record<string, string>, port: number): string {
  const exportParts: string[] = [SANDBOX_AGENT_PATH_EXPORT];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`sprites provider received an invalid environment variable name: ${key}`);
    }
    exportParts.push(`export ${key}=${shellQuote(value)}`);
  }

  exportParts.push(`exec sandbox-agent server --no-token --host 0.0.0.0 --port ${port}`);
  return exportParts.join("; ");
}

type SpriteHandle = Pick<ReturnType<SpritesClient["sprite"]>, "execFileHTTP">;

/**
 * Run a non-interactive command inside the Sprite over the HTTP exec endpoint.
 *
 * The WebSocket exec path keeps stdin attached, which makes some agent
 * installers (their `--help` probe) block forever, so non-interactive setup
 * commands always go through HTTP exec.
 */
async function runSpriteCommand(sprite: SpriteHandle, command: string, options: { env?: Record<string, string>; timeoutMs: number }): Promise<void> {
  const shellCommand = `${SANDBOX_AGENT_PATH_EXPORT}; ${command}`;
  try {
    const result = await sprite.execFileHTTP("bash", ["-lc", shellCommand], {
      env: options.env,
      timeout: options.timeoutMs,
    });
    if (result.exitCode !== 0) {
      throw new Error(`sprites command failed: ${command} (exit ${result.exitCode})\nstdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`);
    }
  } catch (error) {
    if (error instanceof ExecError) {
      throw new Error(`sprites command failed: ${command} (exit ${error.exitCode})\nstdout:\n${String(error.stdout)}\nstderr:\n${String(error.stderr)}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function installSandboxAgent(sprite: SpriteHandle, timeoutMs: number): Promise<void> {
  await runSpriteCommand(sprite, SANDBOX_AGENT_INSTALL_COMMAND, { timeoutMs });
}

async function installAgent(sprite: SpriteHandle, agent: string, env: Record<string, string>, timeoutMs: number): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(agent)) {
    throw new Error(`sprites provider received an invalid agent name: ${agent}`);
  }
  await runSpriteCommand(sprite, `sandbox-agent install-agent ${agent}`, { env, timeoutMs });
}

async function fetchService(client: SpritesClient, spriteName: string, serviceName: string): Promise<SpritesService | undefined> {
  const response = await fetch(`${client.baseURL}/v1/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${client.token}`,
    },
  });

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`sprites service lookup failed (status ${response.status}): ${await response.text()}`);
  }

  return (await response.json()) as SpritesService;
}

async function upsertService(client: SpritesClient, spriteName: string, serviceName: string, port: number, command: string): Promise<void> {
  const existing = await fetchService(client, spriteName, serviceName);
  const expectedArgs = ["-lc", command];
  const isCurrent = existing?.cmd === "bash" && existing.http_port === port && JSON.stringify(existing.args ?? []) === JSON.stringify(expectedArgs);
  if (isCurrent) {
    return;
  }

  const response = await fetch(`${client.baseURL}/v1/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${client.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cmd: "bash",
      args: expectedArgs,
      http_port: port,
    }),
  });

  if (!response.ok) {
    throw new Error(`sprites service upsert failed (status ${response.status}): ${await response.text()}`);
  }
}

async function startServiceIfNeeded(client: SpritesClient, spriteName: string, serviceName: string, duration: string): Promise<void> {
  const existing = await fetchService(client, spriteName, serviceName);
  if (existing?.state?.status === "running" || existing?.state?.status === "starting") {
    return;
  }

  const response = await fetch(
    `${client.baseURL}/v1/sprites/${encodeURIComponent(spriteName)}/services/${encodeURIComponent(serviceName)}/start?duration=${encodeURIComponent(duration)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.token}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`sprites service start failed (status ${response.status}): ${await response.text()}`);
  }

  await response.text();
}

async function ensureService(
  client: SpritesClient,
  spriteName: string,
  serviceName: string,
  port: number,
  duration: string,
  env: Record<string, string>,
): Promise<void> {
  const command = buildServiceCommand(env, port);
  await upsertService(client, spriteName, serviceName, port, command);
  await startServiceIfNeeded(client, spriteName, serviceName, duration);
}

export function sprites(options: SpritesProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
  const serviceStartDuration = options.serviceStartDuration ?? DEFAULT_SERVICE_START_DURATION;
  const namePrefix = options.namePrefix ?? DEFAULT_NAME_PREFIX;
  const installAgents = [...(options.installAgents ?? [])];
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const agentInstallTimeoutMs = options.agentInstallTimeoutMs ?? DEFAULT_AGENT_INSTALL_TIMEOUT_MS;

  const getClient = async (): Promise<SpritesClient> => {
    const token = await resolveToken(options.token);
    const clientOptions = await resolveValue(options.client, {});
    return createSpritesClient(token, clientOptions);
  };

  const getServerEnv = async (): Promise<Record<string, string>> => {
    return await resolveValue(options.env, {});
  };

  const provider: SpritesSandboxProvider = {
    name: "sprites",
    defaultCwd: "/home/sprite",
    async create(): Promise<string> {
      const client = await getClient();
      const createOptions = await resolveValue(options.create, {});
      const spriteName = createOptions.name ?? generateSpriteName(namePrefix);
      const sprite = await client.createSprite(spriteName, createOptions.config);

      const serverEnv = await getServerEnv();
      await installSandboxAgent(sprite, installTimeoutMs);
      for (const agent of installAgents) {
        await installAgent(sprite, agent, serverEnv, agentInstallTimeoutMs);
      }

      await ensureService(client, spriteName, serviceName, agentPort, serviceStartDuration, serverEnv);
      return sprite.name;
    },
    async destroy(sandboxId: string): Promise<void> {
      const client = await getClient();
      try {
        await client.deleteSprite(sandboxId);
      } catch (error) {
        if (isSpriteNotFoundError(error) || (error instanceof Error && error.message.includes("status 404"))) {
          return;
        }
        throw error;
      }
    },
    async reconnect(sandboxId: string): Promise<void> {
      const client = await getClient();
      try {
        await client.getSprite(sandboxId);
      } catch (error) {
        if (isSpriteNotFoundError(error)) {
          throw new SandboxDestroyedError(sandboxId, "sprites", { cause: error });
        }
        throw error;
      }
    },
    async getUrl(sandboxId: string): Promise<string> {
      const client = await getClient();
      const sprite = await client.getSprite(sandboxId);
      const url = (sprite as { url?: string }).url;
      if (!url) {
        throw new Error(`sprites API did not return a URL for sprite: ${sandboxId}`);
      }
      return url;
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const client = await getClient();
      const sprite = await client.getSprite(sandboxId);
      await installSandboxAgent(sprite, installTimeoutMs);
      await ensureService(client, sandboxId, serviceName, agentPort, serviceStartDuration, await getServerEnv());
    },
    async getToken(): Promise<string> {
      return await resolveToken(options.token);
    },
  };

  return provider;
}
