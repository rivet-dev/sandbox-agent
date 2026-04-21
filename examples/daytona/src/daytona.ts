import { Daytona, Image } from "@daytonaio/sdk";
import { SandboxAgent } from "sandbox-agent";
import { daytona } from "sandbox-agent/daytona";

const SNAPSHOT = "sandbox-agent-ready";

class DaytonaSnapshotNotFoundError extends Error {
  constructor(snapshotName: string, options?: ErrorOptions) {
    super(`daytona snapshot not found: ${snapshotName}`, options);
    this.name = "DaytonaSnapshotNotFoundError";
  }
}

async function ensureDaytonaSnapshotExists(client: Daytona, snapshotName: string): Promise<void> {
  try {
    await client.snapshot.get(snapshotName);
  } catch (error) {
    if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404) {
      throw new DaytonaSnapshotNotFoundError(snapshotName, { cause: error });
    }
    throw error;
  }
}

function collectEnvVars(): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return envVars;
}

function inspectorUrlToBaseUrl(inspectorUrl: string): string {
  return inspectorUrl.replace(/\/ui\/$/, "");
}

export async function setupDaytonaSandboxAgent(): Promise<{
  baseUrl: string;
  token?: string;
  extraHeaders?: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const daytonaClient = new Daytona();
  const hasSnapshot = await ensureDaytonaSnapshotExists(daytonaClient, SNAPSHOT).then(
    () => true,
    (error) => {
      if (error instanceof DaytonaSnapshotNotFoundError) return false;
      throw error;
    },
  );

  if (!hasSnapshot) {
    await daytonaClient.snapshot.create({
      name: SNAPSHOT,
      image: Image.base("ubuntu:22.04").runCommands(
        "apt-get update && apt-get install -y curl ca-certificates",
        "curl -fsSL https://releases.rivet.dev/sandbox-agent/0.4.x/install.sh | sh",
        "sandbox-agent install-agent claude",
        "sandbox-agent install-agent codex",
      ),
    });
  }

  const client = await SandboxAgent.start({
    sandbox: daytona({
      create: { snapshot: SNAPSHOT, envVars: collectEnvVars() },
    }),
  });

  return {
    baseUrl: inspectorUrlToBaseUrl(client.inspectorUrl),
    cleanup: async () => {
      await client.killSandbox();
    },
  };
}
