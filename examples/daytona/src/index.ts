import { Daytona, Image } from "@daytonaio/sdk";
import { SandboxAgent } from "sandbox-agent";
import { daytona } from "sandbox-agent/daytona";
import { detectAgent } from "@sandbox-agent/example-shared";

const SNAPSHOT = "sandbox-agent-ready";
const envVars: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
    create: { snapshot: SNAPSHOT, envVars },
  }),
});

console.log(`UI: ${client.inspectorUrl}`);

const session = await client.createSession({
  agent: detectAgent(),
});

session.onEvent((event) => {
  console.log(`[${event.sender}]`, JSON.stringify(event.payload));
});

session.prompt([{ type: "text", text: "Say hello from Daytona in one sentence." }]);

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
