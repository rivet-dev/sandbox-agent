import Docker from "dockerode";
import fs from "node:fs";
import path from "node:path";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl } from "@sandbox-agent/example-shared";
import { FULL_IMAGE } from "@sandbox-agent/example-shared/docker";

const IMAGE = FULL_IMAGE;
const PORT = 3000;
const agent = detectAgent();
const codexAuthPath = process.env.HOME ? path.join(process.env.HOME, ".codex", "auth.json") : null;
const bindMounts = codexAuthPath && fs.existsSync(codexAuthPath) ? [`${codexAuthPath}:/home/sandbox/.codex/auth.json:ro`] : [];

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
  Cmd: ["server", "--no-token", "--host", "0.0.0.0", "--port", `${PORT}`],
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
const session = await client.createSession({ agent, sessionInit: { cwd: "/home/sandbox", mcpServers: [] } });
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
