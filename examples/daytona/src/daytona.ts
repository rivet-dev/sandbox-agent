import { Daytona } from "@daytonaio/sdk";
import { runPrompt } from "@sandbox-agent/example-shared";

const daytona = new Daytona();

const envVars: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY)
	envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY)
	envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Use default image and install sandbox-agent at runtime (faster startup, no snapshot build)
console.log("Creating Daytona sandbox...");
const sandbox = await daytona.create({ envVars, autoStopInterval: 0 });

// Install sandbox-agent and start server
console.log("Installing sandbox-agent...");
await sandbox.process.executeCommand(
	"curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
);

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
