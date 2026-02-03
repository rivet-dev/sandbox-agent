import { execSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

const SANDBOX_NAME = `sandbox-agent-${randomUUID().slice(0, 8)}`;
const PORT = 3000;

function exec(cmd: string, options?: { silent?: boolean }): string {
  if (!options?.silent) console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: "utf-8", stdio: options?.silent ? "pipe" : "inherit" }).toString().trim();
}

function execCapture(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).toString().trim();
}

// Check if Docker Sandbox is available (requires Docker Desktop 4.58+)
function checkDockerSandbox(): void {
  try {
    execCapture("docker sandbox --help");
  } catch {
    throw new Error(
      "Docker Sandbox not available. Requires Docker Desktop 4.58+ on macOS or Windows.\n" +
      "Linux users: Docker Sandbox microVMs are not supported on Linux."
    );
  }
}

// Check if a sandbox exists
function sandboxExists(name: string): boolean {
  try {
    const output = execCapture(`docker sandbox ls --format "{{.Name}}"`);
    return output.split("\n").includes(name);
  } catch {
    return false;
  }
}

// Create the sandbox with claude as the base agent
// Note: Docker Sandbox requires an agent type (claude, codex, gemini, etc.)
async function createSandbox(): Promise<void> {
  console.log(`Creating Docker Sandbox: ${SANDBOX_NAME}...`);

  const envFlags: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) {
    envFlags.push(`-e ANTHROPIC_API_KEY="${process.env.ANTHROPIC_API_KEY}"`);
  }
  if (process.env.OPENAI_API_KEY) {
    envFlags.push(`-e OPENAI_API_KEY="${process.env.OPENAI_API_KEY}"`);
  }

  const workspaceDir = process.cwd();
  exec(`docker sandbox create ${envFlags.join(" ")} --name ${SANDBOX_NAME} claude ${workspaceDir}`);
}

// Execute a command inside the sandbox
function sandboxExec(cmd: string, options?: { silent?: boolean; background?: boolean }): string {
  const fullCmd = `docker sandbox exec ${SANDBOX_NAME} sh -c "${cmd.replace(/"/g, '\\"')}"`;
  if (options?.background) {
    spawn("docker", ["sandbox", "exec", SANDBOX_NAME, "sh", "-c", cmd], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return "";
  }
  return options?.silent ? execCapture(fullCmd) : exec(fullCmd);
}

// Install sandbox-agent inside the sandbox
async function installSandboxAgent(): Promise<void> {
  console.log("Installing sandbox-agent inside sandbox...");
  sandboxExec("curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh");

  console.log("Installing additional agents...");
  // Claude is pre-installed with the sandbox, install codex as additional agent
  sandboxExec("sandbox-agent install-agent codex");
}

// Start sandbox-agent server
async function startServer(): Promise<void> {
  console.log("Starting sandbox-agent server...");
  sandboxExec(`nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT} > /tmp/sandbox-agent.log 2>&1 &`, { background: true });
}

// Get the sandbox's forwarded port URL
// Note: Docker Sandbox microVMs don't expose ports to the host directly.
// This example demonstrates the pattern, but accessing the server requires
// either using docker sandbox exec to interact with it, or waiting for
// Docker to add port forwarding support for sandboxes.
function getBaseUrl(): string {
  // For now, we attempt to access via localhost assuming port forwarding
  // In practice, Docker Sandboxes don't support port mapping yet
  return `http://127.0.0.1:${PORT}`;
}

// Cleanup function
async function cleanup(): Promise<void> {
  console.log(`\nCleaning up sandbox: ${SANDBOX_NAME}...`);
  try {
    execCapture(`docker sandbox rm -f ${SANDBOX_NAME}`);
  } catch {
    // Ignore errors during cleanup
  }
  process.exit(0);
}

// Setup signal handlers
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

export async function setupDockerSandbox(): Promise<{
  sandboxName: string;
  baseUrl: string;
  cleanup: () => Promise<void>;
  exec: (cmd: string) => string;
}> {
  checkDockerSandbox();

  if (sandboxExists(SANDBOX_NAME)) {
    console.log(`Sandbox ${SANDBOX_NAME} already exists, removing...`);
    execCapture(`docker sandbox rm -f ${SANDBOX_NAME}`);
  }

  await createSandbox();
  await installSandboxAgent();
  await startServer();

  const baseUrl = getBaseUrl();

  return {
    sandboxName: SANDBOX_NAME,
    baseUrl,
    cleanup,
    exec: sandboxExec,
  };
}

// Main execution
console.log("Docker Sandbox Example");
console.log("======================");
console.log("");
console.log("NOTE: Docker Sandbox microVMs (Docker Desktop 4.58+) currently do not");
console.log("support inbound port exposure. This example demonstrates the pattern,");
console.log("but you may need to interact with sandbox-agent via 'docker sandbox exec'");
console.log("rather than HTTP until Docker adds port forwarding support.");
console.log("");

try {
  checkDockerSandbox();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

if (sandboxExists(SANDBOX_NAME)) {
  console.log(`Sandbox ${SANDBOX_NAME} already exists, removing...`);
  execCapture(`docker sandbox rm -f ${SANDBOX_NAME}`);
}

await createSandbox();
await installSandboxAgent();
await startServer();

const baseUrl = getBaseUrl();

console.log("");
console.log("Attempting to connect to sandbox-agent...");
console.log(`Base URL: ${baseUrl}`);
console.log("");

try {
  await waitForHealth({ baseUrl, timeoutMs: 30_000 });
  await runPrompt(baseUrl);
} catch (error) {
  console.log("");
  console.log("Could not connect to sandbox-agent server via HTTP.");
  console.log("This is expected with Docker Sandbox microVMs as they don't expose ports.");
  console.log("");
  console.log("You can still interact with sandbox-agent via exec:");
  console.log(`  docker sandbox exec ${SANDBOX_NAME} sandbox-agent --help`);
  console.log("");
  console.log("Or use the CLI to send messages:");
  console.log(`  docker sandbox exec ${SANDBOX_NAME} sandbox-agent api sessions create my-session --agent claude`);
  console.log(`  docker sandbox exec ${SANDBOX_NAME} sandbox-agent api sessions send-message my-session "Hello"`);
  console.log("");
  console.log("For HTTP access, use regular Docker containers instead:");
  console.log("  See: docs/deploy/docker.mdx");
}

await cleanup();
