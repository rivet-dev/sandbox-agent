import { Sandbox } from "@vercel/sandbox";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl, waitForHealth } from "@sandbox-agent/example-shared";

const envs: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log("Creating Vercel sandbox...");
const sandbox = await Sandbox.create({
  runtime: "node24",
  ports: [3000],
});

const run = async (cmd: string, args: string[] = []) => {
  const result = await sandbox.runCommand({ cmd, args, env: envs });
  if (result.exitCode !== 0) {
    const stderr = await result.stderr();
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr}`);
  }
  return result;
};

console.log("Installing sandbox-agent...");
await run("sh", ["-c", "curl -fsSL https://releases.rivet.dev/sandbox-agent/0.2.x/install.sh | sh"]);

console.log("Installing agents...");
await run("sandbox-agent", ["install-agent", "claude"]);
await run("sandbox-agent", ["install-agent", "codex"]);

console.log("Starting server...");
await sandbox.runCommand({
  cmd: "sandbox-agent",
  args: ["server", "--no-token", "--host", "0.0.0.0", "--port", "3000"],
  env: envs,
  detached: true,
});

const baseUrl = sandbox.domain(3000);

console.log("Waiting for server...");
await waitForHealth({ baseUrl });

const client = await SandboxAgent.connect({ baseUrl });
const session = await client.createSession({ agent: detectAgent(), sessionInit: { cwd: "/home/vercel-sandbox", mcpServers: [] } });
const sessionId = session.id;

console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
const cleanup = async () => {
  clearInterval(keepAlive);
  await sandbox.stop();
  process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
