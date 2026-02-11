import { Sandbox } from "@e2b/code-interpreter";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl, waitForHealth } from "@sandbox-agent/example-shared";

const envs: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log("Creating E2B sandbox...");
const sandbox = await Sandbox.create({ allowInternetAccess: true, envs });

const run = async (cmd: string) => {
  const result = await sandbox.commands.run(cmd);
  if (result.exitCode !== 0) throw new Error(`Command failed: ${cmd}\n${result.stderr}`);
  return result;
};

console.log("Installing sandbox-agent...");
await run("curl -fsSL https://releases.rivet.dev/sandbox-agent/0.2.x/install.sh | sh");

console.log("Installing agents...");
await run("sandbox-agent install-agent claude");
await run("sandbox-agent install-agent codex");

console.log("Starting server...");
await sandbox.commands.run("sandbox-agent server --no-token --host 0.0.0.0 --port 3000", { background: true });

const baseUrl = `https://${sandbox.getHost(3000)}`;

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
  await sandbox.kill();
  process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
