import { Daytona, Image } from "@daytonaio/sdk";
import { runPrompt } from "@sandbox-agent/example-shared";

const daytona = new Daytona();

const envVars: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY)
	envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY)
	envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Build a custom image with sandbox-agent pre-installed (slower first run, faster subsequent runs)
const image = Image.base("ubuntu:22.04").runCommands(
	"apt-get update && apt-get install -y curl ca-certificates",
	"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
);

console.log("Creating Daytona sandbox (first run builds the base image and may take a few minutes, subsequent runs are fast)...");
const sandbox = await daytona.create({ envVars, image, autoStopInterval: 0 }, { timeout: 180 });

await sandbox.process.executeCommand(
	"nohup sandbox-agent server --no-token --host 0.0.0.0 --port 3000 >/tmp/sandbox-agent.log 2>&1 &",
);

const baseUrl = (await sandbox.getSignedPreviewUrl(3000, 4 * 60 * 60)).url;

const cleanup = async () => {
	await sandbox.delete(60);
	process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

await runPrompt(baseUrl);
await cleanup();
