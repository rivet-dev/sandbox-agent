import "dotenv/config";
import { compute } from "computesdk";
import { runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

export async function setupComputeSDKSandboxAgent() {
  const envs: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  console.log("Creating ComputeSDK sandbox...");
  const sandbox = await compute.sandbox.create({
    envs,
    servers: [
      {
        slug: "sandbox-agent",
        install:
          "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh && " +
          "sandbox-agent install-agent claude && " +
          "sandbox-agent install-agent codex",
        start: "sandbox-agent server --no-token --host 0.0.0.0 --port 3000",
        port: 3000,
        environment: envs,
        health_check: {
          path: "/v1/health",
          interval_ms: 2000,
          timeout_ms: 5000,
          delay_ms: 3000,
        },
        restart_policy: "on-failure",
        max_restarts: 3,
      },
    ],
  });

  const baseUrl = await sandbox.getUrl({ port: 3000 });

  console.log("Waiting for server...");
  await waitForHealth({ baseUrl });

  const cleanup = async () => {
    await sandbox.destroy();
  };

  return { baseUrl, token: undefined, cleanup };
}

// Run interactively when executed directly
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { baseUrl, cleanup } = await setupComputeSDKSandboxAgent();

  const exitCleanup = async () => {
    console.log("\nDestroying sandbox...");
    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", () => void exitCleanup());
  process.on("SIGTERM", () => void exitCleanup());

  try {
    await runPrompt(baseUrl);
  } catch (err: unknown) {
    if (err instanceof Error && err.name !== "AbortError") {
      console.error("Error:", err.message);
    }
  }
  await exitCleanup();
}
