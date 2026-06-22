import { Daytona, type CreateSandboxFromImageParams, type CreateSandboxFromSnapshotParams } from "@daytonaio/sdk";
import type { SandboxProvider } from "./types.ts";
import { DEFAULT_SANDBOX_AGENT_IMAGE, buildServerStartCommand } from "./shared.ts";

const DEFAULT_AGENT_PORT = 3000;
const DEFAULT_PREVIEW_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_CWD = "/home/sandbox";

type DaytonaCreateOverrides = Partial<CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams>;

export interface DaytonaProviderOptions {
  create?: DaytonaCreateOverrides | (() => DaytonaCreateOverrides | Promise<DaytonaCreateOverrides>);
  image?: CreateSandboxFromImageParams["image"];
  agentPort?: number;
  cwd?: string;
  previewTtlSeconds?: number;
  deleteTimeoutSeconds?: number;
}

async function resolveCreateOptions(value: DaytonaProviderOptions["create"]): Promise<DaytonaCreateOverrides | undefined> {
  if (!value) return undefined;
  if (typeof value === "function") return await value();
  return value;
}

function getSnapshotName(createOpts: DaytonaCreateOverrides | undefined): string | undefined {
  if (!createOpts || !Object.prototype.hasOwnProperty.call(createOpts, "snapshot")) {
    return undefined;
  }
  const snapshot = (createOpts as CreateSandboxFromSnapshotParams).snapshot;
  return typeof snapshot === "string" && snapshot.length > 0 ? snapshot : undefined;
}

export function daytona(options: DaytonaProviderOptions = {}): SandboxProvider {
  const agentPort = options.agentPort ?? DEFAULT_AGENT_PORT;
  const image = options.image ?? DEFAULT_SANDBOX_AGENT_IMAGE;
  const cwd = options.cwd ?? DEFAULT_CWD;
  const previewTtlSeconds = options.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
  const client = new Daytona();

  return {
    name: "daytona",
    defaultCwd: cwd,
    async create(): Promise<string> {
      const createOpts = await resolveCreateOptions(options.create);
      const snapshot = getSnapshotName(createOpts);
      const hasSnapshot = snapshot !== undefined;
      const createImage = createOpts && "image" in createOpts ? createOpts.image : undefined;

      if (hasSnapshot && (options.image !== undefined || createImage !== undefined)) {
        throw new Error("daytona provider does not support combining snapshot with image; pass only create.snapshot or image");
      }

      const sandbox = hasSnapshot
        ? await client.create({
            autoStopInterval: 0,
            ...createOpts,
          } as CreateSandboxFromSnapshotParams)
        : await client.create({
            image,
            autoStopInterval: 0,
            ...createOpts,
          } as CreateSandboxFromImageParams);
      await sandbox.process.executeCommand(buildServerStartCommand(agentPort));
      return sandbox.id;
    },
    async destroy(sandboxId: string): Promise<void> {
      const sandbox = await client.get(sandboxId);
      if (!sandbox) {
        return;
      }
      await sandbox.delete(options.deleteTimeoutSeconds);
    },
    async getUrl(sandboxId: string): Promise<string> {
      const sandbox = await client.get(sandboxId);
      if (!sandbox) {
        throw new Error(`daytona sandbox not found: ${sandboxId}`);
      }
      const preview = await sandbox.getSignedPreviewUrl(agentPort, previewTtlSeconds);
      return typeof preview === "string" ? preview : preview.url;
    },
    async ensureServer(sandboxId: string): Promise<void> {
      const sandbox = await client.get(sandboxId);
      if (!sandbox) {
        throw new Error(`daytona sandbox not found: ${sandboxId}`);
      }
      await sandbox.process.executeCommand(buildServerStartCommand(agentPort));
    },
  };
}
