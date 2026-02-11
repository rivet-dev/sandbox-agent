import { Daytona } from "@daytonaio/sdk";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl, waitForHealth } from "@sandbox-agent/example-shared";

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
	"curl -fsSL https://releases.rivet.dev/sandbox-agent/0.2.x/install.sh | sh",
);

await sandbox.process.executeCommand(
	"nohup sandbox-agent server --no-token --host 0.0.0.0 --port 3000 >/tmp/sandbox-agent.log 2>&1 &",
);

const baseUrl = (await sandbox.getSignedPreviewUrl(3000, 4 * 60 * 60)).url;

console.log("Waiting for server...");
await waitForHealth({ baseUrl });

const client = await SandboxAgent.connect({ baseUrl });
const session = await client.createSession({ agent: detectAgent(), sessionInit: { cwd: "/root", mcpServers: [] } });
const sessionId = session.id;

console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
const cleanup = async () => {
	clearInterval(keepAlive);
	await sandbox.delete(60);
	process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
