import { ModalClient } from "modal";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl, waitForHealth } from "@sandbox-agent/example-shared";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { run } from "node:test";

const PORT = 3000;
const APP_NAME = "sandbox-agent";

async function buildSecrets(modal: ModalClient) {
  const envVars: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) 
    envVars.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) 
    envVars.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  if (Object.keys(envVars).length === 0) return [];
  return [await modal.secrets.fromObject(envVars)];
}

export async function setupModalSandboxAgent(): Promise<{
  baseUrl: string;
  cleanup: () => Promise<void>;
}> {
  const modal = new ModalClient();
  const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });

  const image = modal.images
    .fromRegistry("ubuntu:22.04")
    .dockerfileCommands([
      "RUN apt-get update && apt-get install -y curl ca-certificates",
      "RUN curl -fsSL https://releases.rivet.dev/sandbox-agent/0.2.x/install.sh | sh",
    ]);

  const secrets = await buildSecrets(modal);

  console.log("Creating Modal sandbox!");
  const sb = await modal.sandboxes.create(app, image, {
    secrets: secrets, 
    encryptedPorts: [PORT],
  });
  console.log(`Sandbox created: ${sb.sandboxId}`);

  const exec = async (cmd: string) => {
    const p = await sb.exec(["bash", "-c", cmd], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await p.wait();
    if (exitCode !== 0) {
      const stderr = await p.stderr.readText();
      throw new Error(`Command failed (exit ${exitCode}): ${cmd}\n${stderr}`);
    }
  };

  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Installing Claude agent...");
    await exec("sandbox-agent install-agent claude");
  }
  if (process.env.OPENAI_API_KEY) {
    console.log("Installing Codex agent...");
    await exec("sandbox-agent install-agent codex");
  }

  console.log("Starting server...");

  await sb.exec(
    ["bash", "-c", `sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT} &`],
  );

  const tunnels = await sb.tunnels();
  const tunnel = tunnels[PORT];
  if (!tunnel) {
    throw new Error(`No tunnel found for port ${PORT}`);
  }
  const baseUrl = tunnel.url;

  console.log("Waiting for server...");
  await waitForHealth({ baseUrl });

  const cleanup = async () => {
    try {
      await sb.terminate();
    } catch (error) {
      console.warn("Cleanup failed:", error instanceof Error ? error.message : error);
    }
  };

  return { baseUrl, cleanup };
}

export async function runModalExample(): Promise<void> {
  const { baseUrl, cleanup } = await setupModalSandboxAgent();

  const handleExit = async () => {
    await cleanup();
    process.exit(0);
  };

  process.once("SIGINT", handleExit);
  process.once("SIGTERM", handleExit);

  const client = await SandboxAgent.connect({ baseUrl });
  const session = await client.createSession({ agent: detectAgent(), sessionInit: { cwd: "/root", mcpServers: [] } });
  const sessionId = session.id;

  console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
  console.log("  Press Ctrl+C to stop.");

  await new Promise(() => {});
}

const isDirectRun = Boolean(
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url),
);

if (isDirectRun) {
  runModalExample().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
