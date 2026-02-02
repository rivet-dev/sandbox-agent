import { Sandbox } from "@e2b/code-interpreter";
import { runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

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
await run("curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh");

console.log("Installing agents...");
await run("sandbox-agent install-agent claude");
await run("sandbox-agent install-agent codex");

console.log("Starting server...");
await sandbox.commands.run("sandbox-agent server --no-token --host 0.0.0.0 --port 3000", { background: true });

const baseUrl = `https://${sandbox.getHost(3000)}`;

console.log("Waiting for server...");
await waitForHealth({ baseUrl });

const cleanup = async () => {
  await sandbox.kill();
  process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

await runPrompt(baseUrl);
await cleanup();
