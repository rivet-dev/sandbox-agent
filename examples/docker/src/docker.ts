import Docker from "dockerode";
import { runPrompt, waitForHealth } from "@sandbox-agent/example-shared";

const IMAGE = "alpine:latest";
const PORT = 3000;

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
  try { await container.stop({ t: 5 }); } catch {}
  try { await container.remove({ force: true }); } catch {}
  process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);

await runPrompt(baseUrl);
await cleanup();
