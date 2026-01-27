import { Daytona } from "@daytonaio/sdk";
import { pathToFileURL } from "node:url";
import {
  ensureUrl,
  runPrompt,
  waitForHealth,
} from "../shared/sandbox-agent-client.ts";

const INSTALL_SCRIPT = "curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh";
const DEFAULT_PORT = 3000;

export async function setupDaytonaSandboxAgent(): Promise<{
  baseUrl: string;
  token: string;
  extraHeaders: Record<string, string>;
  cleanup: () => Promise<void>;
}> {
  const token = process.env.SANDBOX_TOKEN || "";
  const port = Number.parseInt(process.env.SANDBOX_PORT || "", 10) || DEFAULT_PORT;
  const language = process.env.DAYTONA_LANGUAGE || "typescript";

  const daytona = new Daytona();
  const sandbox = await daytona.create({
    language,
  });

  await sandbox.process.executeCommand(`bash -lc "${INSTALL_SCRIPT}"`);

  const tokenFlag = token ? "--token $SANDBOX_TOKEN" : "--no-token";
  const serverCommand = `nohup sandbox-agent server ${tokenFlag} --host 0.0.0.0 --port ${port} >/tmp/sandbox-agent.log 2>&1 &`;
  await sandbox.process.executeCommand(`bash -lc "${serverCommand}"`);

  const preview = await sandbox.getPreviewLink(port);
  const extraHeaders: Record<string, string> = {};
  if (preview.token) {
    extraHeaders["x-daytona-preview-token"] = preview.token;
  }
  extraHeaders["x-daytona-skip-preview-warning"] = "true";

  const baseUrl = ensureUrl(preview.url);
  await waitForHealth({ baseUrl, token, extraHeaders });

  const cleanup = async () => {
    try {
      await sandbox.delete(60);
    } catch {
      // ignore cleanup errors
    }
  };

  return {
    baseUrl,
    token,
    extraHeaders,
    cleanup,
  };
}

async function main(): Promise<void> {
  const { baseUrl, token, extraHeaders, cleanup } = await setupDaytonaSandboxAgent();

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

  await runPrompt({ baseUrl, token, extraHeaders });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
