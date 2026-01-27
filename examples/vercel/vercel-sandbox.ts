import { Sandbox } from "@vercel/sandbox";
import { pathToFileURL } from "node:url";
import {
  ensureUrl,
  runPrompt,
  waitForHealth,
} from "../shared/sandbox-agent-client.ts";

const INSTALL_SCRIPT = "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh";
const DEFAULT_PORT = 2468;

type VercelSandboxOptions = {
  runtime: string;
  ports: number[];
  token?: string;
  teamId?: string;
  projectId?: string;
};

export async function setupVercelSandboxAgent(): Promise<{
  baseUrl: string;
  token: string;
  cleanup: () => Promise<void>;
}> {
  const token = process.env.SANDBOX_TOKEN || "";
  const port = Number.parseInt(process.env.SANDBOX_PORT || "", 10) || DEFAULT_PORT;
  const runtime = process.env.VERCEL_RUNTIME || "node24";

  const createOptions: VercelSandboxOptions = {
    runtime,
    ports: [port],
  };

  const accessToken = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (accessToken && teamId && projectId) {
    createOptions.token = accessToken;
    createOptions.teamId = teamId;
    createOptions.projectId = projectId;
  }

  const sandbox = await Sandbox.create(createOptions);

  await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", INSTALL_SCRIPT],
    sudo: true,
  });

  const tokenFlag = token ? "--token $SANDBOX_TOKEN" : "--no-token";
  await sandbox.runCommand({
    cmd: "bash",
    args: [
      "-lc",
      `SANDBOX_TOKEN=${token} sandbox-agent server ${tokenFlag} --host 0.0.0.0 --port ${port}`,
    ],
    sudo: true,
    detached: true,
  });

  const baseUrl = ensureUrl(sandbox.domain(port));
  await waitForHealth({ baseUrl, token });

  const cleanup = async () => {
    try {
      await sandbox.stop();
    } catch {
      // ignore cleanup errors
    }
  };

  return {
    baseUrl,
    token,
    cleanup,
  };
}

async function main(): Promise<void> {
  const { baseUrl, token, cleanup } = await setupVercelSandboxAgent();

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
