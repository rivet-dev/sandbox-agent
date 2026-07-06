import { type CreateosSandboxClientOptions, CreateosSandboxNotFoundError, type CreateSandboxRequest, Sandbox } from "@nodeops-createos/sandbox";
import { SandboxDestroyedError } from "../client.ts";
import { buildServerStartCommand, DEFAULT_AGENTS, SANDBOX_AGENT_INSTALL_SCRIPT } from "./shared.ts";
import type { SandboxProvider } from "./types.ts";

const DEFAULT_AGENT_PORT = 3000;
// createos requires a shape at create time; this is a sane default for running
// sandbox-agent plus a coding agent. Override via `shape` / `create`.
const DEFAULT_SHAPE = "s-1vcpu-1gb";
const DEFAULT_CWD = "/root";
// sandbox-agent installs into /usr/local/bin or ~/.local/bin; a login shell
// won't always have the latter on PATH, so export it before every command.
const SANDBOX_AGENT_PATH_EXPORT = 'export PATH="/usr/local/bin:$HOME/.local/bin:$PATH"';

type CreateOverrides = Omit<Partial<CreateSandboxRequest>, "shape"> & { shape?: string };
type CreateOverridesInput = CreateOverrides | (() => CreateOverrides | Promise<CreateOverrides>);

export interface CreateosProviderOptions {
  /** Client options forwarded to the createos SDK (apiKey, baseUrl, …). */
  client?: CreateosSandboxClientOptions;
  /** Shape id from `listShapes()`. Defaults to {@link DEFAULT_SHAPE}. */
  shape?: string;
  /** Rootfs catalog name or template id. Empty = host default. */
  rootfs?: string;
  /** Extra create-request overrides, or a factory returning them. */
  create?: CreateOverridesInput;
  /** In-guest port the sandbox-agent server listens on. */
  agentPort?: number;
  /** Default working directory for sessions. */
  defaultCwd?: string;
  /** URL scheme for the ingress preview URL. Defaults to "https"; pass
   *  "http" when the ingress TLS cert has not been provisioned yet. */
  scheme?: "http" | "https";
}

async function resolveCreate(value: CreateOverridesInput | undefined): Promise<CreateOverrides> {
  if (!value) return {};
  return typeof value === "function" ? await value() : value;
}

function shScript(command: string): string {
  return `${SANDBOX_AGENT_PATH_EXPORT}; ${command}`;
}

export function createos(options: CreateosProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const scheme = options.scheme ?? "https";
  const clientOptions = options.client ?? {};

  const connect = (sandboxId: string) => Sandbox.connect(sandboxId, { ...clientOptions });

  return {
    name: "createos",
    defaultCwd: options.defaultCwd ?? DEFAULT_CWD,
    async create(): Promise<string> {
      const overrides = await resolveCreate(options.create);
      const request: CreateSandboxRequest = {
        shape: options.shape ?? overrides.shape ?? DEFAULT_SHAPE,
        ...(options.rootfs !== undefined ? { rootfs: options.rootfs } : {}),
        ...overrides,
        // Ingress is how we reach the agent server from outside the sandbox.
        ingress_enabled: true,
      };

      const sandbox = await Sandbox.create(request, { ...clientOptions });

      await sandbox.sh(shScript(`curl -fsSL ${SANDBOX_AGENT_INSTALL_SCRIPT} | sh`), {
        label: "createos install",
      });
      for (const agent of DEFAULT_AGENTS) {
        await sandbox.sh(shScript(`sandbox-agent install-agent ${agent}`), {
          label: `createos install-agent ${agent}`,
        });
      }
      await sandbox.sh(shScript(buildServerStartCommand(agentPort)), {
        label: "createos server start",
      });

      return sandbox.id;
    },
    async destroy(sandboxId: string): Promise<void> {
      const sandbox = await connect(sandboxId);
      await sandbox.destroy();
    },
    async reconnect(sandboxId: string): Promise<void> {
      let sandbox: Sandbox;
      try {
        sandbox = await connect(sandboxId);
      } catch (error) {
        if (error instanceof CreateosSandboxNotFoundError) {
          throw new SandboxDestroyedError(sandboxId, "createos", { cause: error });
        }
        throw error;
      }
      if (sandbox.status === "paused") {
        await sandbox.resume();
      }
    },
    async pause(sandboxId: string): Promise<void> {
      const sandbox = await connect(sandboxId);
      await sandbox.pause();
    },
    async kill(sandboxId: string): Promise<void> {
      const sandbox = await connect(sandboxId);
      await sandbox.destroy();
    },
    async getUrl(sandboxId: string): Promise<string> {
      const sandbox = await connect(sandboxId);
      if (!sandbox.data.ingress_enabled) {
        await sandbox.setIngress(true);
      }
      return sandbox.previewUrl(agentPort, { scheme });
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const sandbox = await connect(sandboxId);
      if (sandbox.status === "paused") {
        await sandbox.resume();
      }
      // Idempotent: a duplicate server exits on port conflict.
      await sandbox.sh(shScript(buildServerStartCommand(agentPort)), {
        label: "createos ensure server",
      });
    },
  };
}
