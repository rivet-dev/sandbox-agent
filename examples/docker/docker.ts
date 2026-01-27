import Docker from "dockerode";
import { pathToFileURL } from "node:url";
import {
  ensureUrl,
  runPrompt,
  waitForHealth,
} from "../shared/sandbox-agent-client.ts";

const INSTALL_SCRIPT = "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh";
const DEFAULT_IMAGE = "debian:bookworm-slim";
const DEFAULT_PORT = 2468;

async function pullImage(docker: Docker, image: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      docker.modem.followProgress(stream, (progressError) => {
        if (progressError) {
          reject(progressError);
        } else {
          resolve();
        }
      });
    });
  });
}

async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch {
    await pullImage(docker, image);
  }
}

export async function setupDockerSandboxAgent(): Promise<{
  baseUrl: string;
  token: string;
  cleanup: () => Promise<void>;
}> {
  const token = process.env.SANDBOX_TOKEN || "";
  const port = Number.parseInt(process.env.SANDBOX_PORT || "", 10) || DEFAULT_PORT;
  const hostPort = Number.parseInt(process.env.SANDBOX_HOST_PORT || "", 10) || port;
  const image = process.env.DOCKER_IMAGE || DEFAULT_IMAGE;
  const containerName = process.env.DOCKER_CONTAINER_NAME;
  const socketPath = process.env.DOCKER_SOCKET || "/var/run/docker.sock";

  const docker = new Docker({ socketPath });
  await ensureImage(docker, image);

  const tokenFlag = token ? "--token $SANDBOX_TOKEN" : "--no-token";
  const command = [
    "bash",
    "-lc",
    [
      "apt-get update",
      "apt-get install -y curl ca-certificates",
      INSTALL_SCRIPT,
      `sandbox-agent server ${tokenFlag} --host 0.0.0.0 --port ${port}`,
    ].join(" && "),
  ];

  const container = await docker.createContainer({
    Image: image,
    Cmd: command,
    Env: token ? [`SANDBOX_TOKEN=${token}`] : [],
    ExposedPorts: {
      [`${port}/tcp`]: {},
    },
    HostConfig: {
      AutoRemove: true,
      PortBindings: {
        [`${port}/tcp`]: [{ HostPort: `${hostPort}` }],
      },
    },
    ...(containerName ? { name: containerName } : {}),
  });

  await container.start();

  const baseUrl = ensureUrl(`http://127.0.0.1:${hostPort}`);
  await waitForHealth({ baseUrl, token });

  const cleanup = async () => {
    try {
      await container.stop({ t: 5 });
    } catch {
      // ignore stop errors
    }
    try {
      await container.remove({ force: true });
    } catch {
      // ignore remove errors
    }
  };

  return {
    baseUrl,
    token,
    cleanup,
  };
}

async function main(): Promise<void> {
  const { baseUrl, token, cleanup } = await setupDockerSandboxAgent();

  const exitHandler = async () => {
    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void exitHandler();
  });
  process.on("SIGTERM", () => {
    void exitHandler();
  });

  await runPrompt({ baseUrl, token });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
