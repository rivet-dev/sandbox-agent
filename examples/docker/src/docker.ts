import Docker from "dockerode";
import { logInspectorUrl, runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

// Alpine is required because Claude Code binary is built for musl libc
const IMAGE = "alpine:latest";
const PORT = 3000;

export async function setupDockerSandboxAgent(): Promise<{
  baseUrl: string;
  token?: string;
  cleanup: () => Promise<void>;
}> {
  const docker = new Docker({ socketPath: "/var/run/docker.sock" });

  // Pull image if needed
  try {
    await docker.getImage(IMAGE).inspect();
  } catch {
    console.log(`Pulling ${IMAGE}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve());
      });
    });
  }

  console.log("Starting container...");
  const container = await docker.createContainer({
    Image: IMAGE,
    Cmd: ["sh", "-c", [
      // Install dependencies (Alpine uses apk, not apt-get)
      "apk add --no-cache curl ca-certificates libstdc++ libgcc bash",
      "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
      "sandbox-agent install-agent claude",
      "sandbox-agent install-agent codex",
      `sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT}`,
    ].join(" && ")],
    Env: [
      process.env.ANTHROPIC_API_KEY ? `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}` : "",
      process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}` : "",
    ].filter(Boolean),
    ExposedPorts: { [`${PORT}/tcp`]: {} },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { [`${PORT}/tcp`]: [{ HostPort: `${PORT}` }] },
    },
  });
  await container.start();

  const baseUrl = `http://127.0.0.1:${PORT}`;
  await waitForHealth({ baseUrl });

  const cleanup = async () => {
    console.log("Cleaning up...");
    try { await container.stop({ t: 5 }); } catch {}
    try { await container.remove({ force: true }); } catch {}
  };

  return { baseUrl, cleanup };
}

// Run interactively if executed directly
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("OPENAI_API_KEY or ANTHROPIC_API_KEY required");
  }

  const { baseUrl, cleanup } = await setupDockerSandboxAgent();
  logInspectorUrl({ baseUrl });

  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  // When running as root in a container, Claude requires interactive permission prompts
  // (bypass mode is not supported). Set autoApprovePermissions: true to auto-approve,
  // or leave false for interactive prompts.
  await runPrompt({
    baseUrl,
    autoApprovePermissions: process.env.AUTO_APPROVE_PERMISSIONS === "true",
  });
  await cleanup();
}
