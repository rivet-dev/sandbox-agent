import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl, generateInstallCommand } from "@sandbox-agent/example-shared";

const IMAGE = "node:22-bookworm-slim";
const PORT = 3000;
const agent = detectAgent();
const codexAuthPath = process.env.HOME ? path.join(process.env.HOME, ".codex", "auth.json") : null;
const bindMounts = codexAuthPath && fs.existsSync(codexAuthPath) ? [`${codexAuthPath}:/root/.codex/auth.json:ro`] : [];

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

// Pull image if needed
try {
  await docker.getImage(IMAGE).inspect();
} catch {
  console.log(`Pulling ${IMAGE}...`);
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
    });
  });
}

console.log("Starting container...");
const container = await docker.createContainer({
  Image: IMAGE,
  Cmd: [
    "sh",
    "-c",
    [
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates bash libstdc++6",
      "rm -rf /var/lib/apt/lists/*",
      generateInstallCommand(),
      `sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT}`,
    ].join(" && "),
  ],
  Env: [
    process.env.ANTHROPIC_API_KEY ? `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}` : "",
    process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}` : "",
    process.env.CODEX_API_KEY ? `CODEX_API_KEY=${process.env.CODEX_API_KEY}` : "",
  ].filter(Boolean),
  ExposedPorts: { [`${PORT}/tcp`]: {} },
  HostConfig: {
    AutoRemove: true,
    PortBindings: { [`${PORT}/tcp`]: [{ HostPort: `${PORT}` }] },
    Binds: bindMounts,
  },
});
await container.start();

const baseUrl = `http://127.0.0.1:${PORT}`;

const client = await SandboxAgent.connect({ baseUrl });
const session = await client.createSession({ agent, sessionInit: { cwd: "/root", mcpServers: [] } });
const sessionId = session.id;

console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
console.log("  Press Ctrl+C to stop.");

const keepAlive = setInterval(() => {}, 60_000);
const cleanup = async () => {
  clearInterval(keepAlive);
  try {
    await container.stop({ t: 5 });
  } catch {}
  try {
    await container.remove({ force: true });
  } catch {}
  process.exit(0);
};
process.once("SIGINT", cleanup);
process.once("SIGTERM", cleanup);
