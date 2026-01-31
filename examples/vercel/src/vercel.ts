import { Sandbox } from "@vercel/sandbox";
import { logInspectorUrl, runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

export async function setupVercelSandboxAgent(): Promise<{
  baseUrl: string;
  token?: string;
  cleanup: () => Promise<void>;
}> {
  // Build env vars for agent API keys
  const envs: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  // Create sandbox with port 3000 exposed
  const sandbox = await Sandbox.create({
    runtime: "node24",
    ports: [3000],
  });

  // Helper to run commands and check exit code
  const run = async (cmd: string, args: string[] = []) => {
    const result = await sandbox.runCommand({ cmd, args, env: envs });
    if (result.exitCode !== 0) {
      const stderr = await result.stderr();
      throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr}`);
    }
    return result;
  };

  console.log("Installing sandbox-agent...");
  await run("sh", ["-c", "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh"]);

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

  const cleanup = async () => {
    console.log("Cleaning up...");
    await sandbox.stop();
  };

  return { baseUrl, cleanup };
}

// Run interactively if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  // Check for Vercel auth
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.VERCEL_ACCESS_TOKEN) {
    throw new Error("Vercel authentication required. Run 'vercel env pull' or set VERCEL_ACCESS_TOKEN");
  }

  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY or ANTHROPIC_API_KEY required");
  }

  const { baseUrl, cleanup } = await setupVercelSandboxAgent();
  logInspectorUrl({ baseUrl });

  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  await runPrompt({
    baseUrl,
    autoApprovePermissions: process.env.AUTO_APPROVE_PERMISSIONS === "true",
  });
  await cleanup();
}
