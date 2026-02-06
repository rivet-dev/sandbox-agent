import Docker from "dockerode";
import { waitForHealth } from "@sandbox-agent/example-shared";
import { createOpencodeClient } from "@opencode-ai/sdk";

const IMAGE = "alpine:latest";
const PORT = 2468;

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

async function ensureImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch {
    console.log(`Pulling ${image}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (followError: Error | null) => {
          if (followError) return reject(followError);
          resolve();
        });
      });
    });
  }
}

async function setupDockerSandboxAgent(): Promise<{
  baseUrl: string;
  cleanup: () => Promise<void>;
}> {
  await ensureImage(IMAGE);

  console.log("Starting container...");
  const container = await docker.createContainer({
    Image: IMAGE,
    Cmd: [
      "sh",
      "-c",
      [
        "apk add --no-cache curl ca-certificates libstdc++ libgcc bash",
        "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh",
        "sandbox-agent install-agent claude",
        "sandbox-agent install-agent codex",
        `sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT}`,
      ].join(" && "),
    ],
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
    try {
      await container.stop({ t: 5 });
    } catch {}
    try {
      await container.remove({ force: true });
    } catch {}
  };

  return { baseUrl, cleanup };
}

const { baseUrl, cleanup } = await setupDockerSandboxAgent();
process.once("SIGINT", async () => {
  await cleanup();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await cleanup();
  process.exit(0);
});

const opencodeBaseUrl = `${baseUrl}/opencode`;
console.log(`OpenCode API: ${opencodeBaseUrl}`);

const client = createOpencodeClient({ baseUrl: opencodeBaseUrl });

const health = await client.global.health();
const healthError = (health as any)?.error;
if (healthError) {
  console.warn(`OpenCode health error: ${healthError}`);
} else {
  console.log("OpenCode health: ok");
}

const session = await client.session.create();
const sessionId = session.data?.id;
if (!sessionId) {
  await cleanup();
  throw new Error("OpenCode session ID missing");
}

const eventStream = await client.event.subscribe();
const stream = (eventStream as any).stream as AsyncIterable<any> & { return?: () => Promise<void> };

await client.session.promptAsync({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "Say hello from OpenCode." }],
  },
});

const timeout = setTimeout(() => {
  void stream.return?.();
}, 60_000);

try {
  for await (const event of stream) {
    const eventSessionId = event?.properties?.session?.id ?? event?.session?.id;
    if (eventSessionId && eventSessionId !== sessionId) continue;
    const type = event?.type ?? "unknown";
    console.log(`event: ${type}`);
    if (type === "session.idle" || type === "session.error") {
      break;
    }
  }
} finally {
  clearTimeout(timeout);
  await stream.return?.();
}

await cleanup();
