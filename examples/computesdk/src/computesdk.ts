import "dotenv/config";
import { compute } from "computesdk";
import { runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

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
        "export BIN_DIR=$HOME/.local/bin && " +
        "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh && " +
        "export PATH=$BIN_DIR:$PATH && " +
        "sandbox-agent install-agent claude && " +
        "sandbox-agent install-agent codex",
      start: "export PATH=$HOME/.local/bin:$PATH && sandbox-agent server --no-token --host 0.0.0.0 --port 3000",
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
  process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

await runPrompt(baseUrl);
await cleanup();
