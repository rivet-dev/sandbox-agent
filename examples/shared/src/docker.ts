import Docker from "dockerode";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForHealth } from "./sandbox-agent-client.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_IMAGE = "ubuntu:22.04";
const DEFAULT_BINARY_PATH = path.resolve(__dirname, "../../../target/release/sandbox-agent");

export interface DockerSandboxOptions {
  port: number;
  /** Extra apt packages to install (e.g. ["nodejs"]). ca-certificates and curl are always included. */
  packages?: string[];
  /** Docker image to use. Defaults to ubuntu:22.04. */
  image?: string;
  /** Path to the sandbox-agent binary. Defaults to target/release/sandbox-agent. */
  binaryPath?: string;
}

export interface DockerSandbox {
  baseUrl: string;
  cleanup: () => Promise<void>;
}

/**
 * Start a Docker container running sandbox-agent and wait for it to be healthy.
 * Registers SIGINT/SIGTERM handlers for cleanup.
 */
export async function startDockerSandbox(opts: DockerSandboxOptions): Promise<DockerSandbox> {
  const { port, image = DEFAULT_IMAGE, binaryPath = DEFAULT_BINARY_PATH } = opts;
  const packages = ["ca-certificates", "curl", ...(opts.packages ?? [])];

  const docker = new Docker({ socketPath: "/var/run/docker.sock" });

  try {
    await docker.getImage(image).inspect();
  } catch {
    console.log(`  Pulling ${image}...`);
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve()));
      });
    });
  }

  const container = await docker.createContainer({
    Image: image,
    Cmd: ["sh", "-c", [
      `apt-get update -qq && apt-get install -y -qq ${packages.join(" ")} >/dev/null 2>&1`,
      "sandbox-agent install-agent claude",
      `sandbox-agent server --no-token --host 0.0.0.0 --port ${port}`,
    ].join(" && ")],
    Env: [
      process.env.ANTHROPIC_API_KEY ? `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}` : "",
      process.env.OPENAI_API_KEY ? `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}` : "",
    ].filter(Boolean),
    ExposedPorts: { [`${port}/tcp`]: {} },
    HostConfig: {
      AutoRemove: true,
      PortBindings: { [`${port}/tcp`]: [{ HostPort: `${port}` }] },
      Binds: [`${binaryPath}:/usr/local/bin/sandbox-agent:ro`],
    },
  });
  await container.start();

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth({ baseUrl });
  console.log("  Container ready.");

  const cleanup = async () => {
    try { await container.stop({ t: 5 }); } catch {}
    try { await container.remove({ force: true }); } catch {}
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  return { baseUrl, cleanup };
}
