import { Sandbox } from "@e2b/code-interpreter";
import { pathToFileURL } from "node:url";
import {
  ensureUrl,
  runPrompt,
  waitForHealth,
} from "../shared/sandbox-agent-client.ts";

const INSTALL_SCRIPT = "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh";
const DEFAULT_PORT = 2468;

type CommandRunner = (command: string, options?: Record<string, unknown>) => Promise<unknown>;

function resolveCommandRunner(sandbox: Sandbox): CommandRunner {
  if (sandbox.commands?.run) {
    return sandbox.commands.run.bind(sandbox.commands);
  }
  if (sandbox.commands?.exec) {
    return sandbox.commands.exec.bind(sandbox.commands);
  }
  throw new Error("E2B SDK does not expose commands.run or commands.exec");
}

export async function setupE2BSandboxAgent(): Promise<{
  baseUrl: string;
  token: string;
  cleanup: () => Promise<void>;
}> {
  const token = process.env.SANDBOX_TOKEN || "";
  const port = Number.parseInt(process.env.SANDBOX_PORT || "", 10) || DEFAULT_PORT;

  const sandbox = await Sandbox.create({
    allowInternetAccess: true,
    envs: token ? { SANDBOX_TOKEN: token } : undefined,
  });

  const runCommand = resolveCommandRunner(sandbox);

  await runCommand(`bash -lc "${INSTALL_SCRIPT}"`);
  const tokenFlag = token ? "--token $SANDBOX_TOKEN" : "--no-token";
  await runCommand(`bash -lc "sandbox-agent server ${tokenFlag} --host 0.0.0.0 --port ${port}"`, {
    background: true,
    envs: token ? { SANDBOX_TOKEN: token } : undefined,
  });

  const baseUrl = ensureUrl(sandbox.getHost(port));
  await waitForHealth({ baseUrl, token });

  const cleanup = async () => {
    try {
      await sandbox.kill();
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
  const { baseUrl, token, cleanup } = await setupE2BSandboxAgent();

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
