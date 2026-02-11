import {
  compute,
  detectProvider,
  getMissingEnvVars,
  getProviderConfigFromEnv,
  isProviderAuthComplete,
  isValidProvider,
  PROVIDER_NAMES,
  type ExplicitComputeConfig,
  type ProviderName,
} from "computesdk";
import { SandboxAgent } from "sandbox-agent";
import { detectAgent, buildInspectorUrl, waitForHealth } from "@sandbox-agent/example-shared";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PORT = 3000;
const REQUEST_TIMEOUT_MS =
  Number.parseInt(process.env.COMPUTESDK_TIMEOUT_MS || "", 10) || 120_000;

/**
 * Detects and validates the provider to use.
 * Priority: COMPUTESDK_PROVIDER env var > auto-detection from API keys
 */
function resolveProvider(): ProviderName {
  const providerOverride = process.env.COMPUTESDK_PROVIDER;
  
  if (providerOverride) {
    if (!isValidProvider(providerOverride)) {
      throw new Error(
        `Unsupported ComputeSDK provider "${providerOverride}". Supported providers: ${PROVIDER_NAMES.join(", ")}`
      );
    }
    if (!isProviderAuthComplete(providerOverride)) {
      const missing = getMissingEnvVars(providerOverride);
      throw new Error(
        `Missing credentials for provider "${providerOverride}". Set: ${missing.join(", ")}`
      );
    }
    console.log(`Using ComputeSDK provider: ${providerOverride} (explicit)`);
    return providerOverride as ProviderName;
  }
  
  const detected = detectProvider();
  if (!detected) {
    throw new Error(
      `No provider credentials found. Set one of: ${PROVIDER_NAMES.map((p) => getMissingEnvVars(p).join(", ")).join(" | ")}`
    );
  }
  console.log(`Using ComputeSDK provider: ${detected} (auto-detected)`);
  return detected as ProviderName;
}

function configureComputeSDK(): void {
  const provider = resolveProvider();
  
  const config: ExplicitComputeConfig = {
    provider,
    computesdkApiKey: process.env.COMPUTESDK_API_KEY,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  };
  
  const providerConfig = getProviderConfigFromEnv(provider);
  if (Object.keys(providerConfig).length > 0) {
    const configWithProvider =
      config as ExplicitComputeConfig & Record<ProviderName, Record<string, string>>;
    configWithProvider[provider] = providerConfig;
  }
  
  compute.setConfig(config);
}

configureComputeSDK();

const buildEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return env;
};

export async function setupComputeSdkSandboxAgent(): Promise<{
  baseUrl: string;
  cleanup: () => Promise<void>;
}> {
  const env = buildEnv();

  console.log("Creating ComputeSDK sandbox...");
  const sandbox = await compute.sandbox.create({
    envs: Object.keys(env).length > 0 ? env : undefined,
  });

  const run = async (cmd: string, options?: { background?: boolean }) => {
    const result = await sandbox.runCommand(cmd, options);
    if (typeof result?.exitCode === "number" && result.exitCode !== 0) {
      throw new Error(`Command failed: ${cmd} (exit ${result.exitCode})\n${result.stderr || ""}`);
    }
    return result;
  };

  console.log("Installing sandbox-agent...");
  await run("curl -fsSL https://releases.rivet.dev/sandbox-agent/latest/install.sh | sh");

  if (env.ANTHROPIC_API_KEY) {
    console.log("Installing Claude agent...");
    await run("sandbox-agent install-agent claude");
  }

  if (env.OPENAI_API_KEY) {
    console.log("Installing Codex agent...");
    await run("sandbox-agent install-agent codex");
  }

  console.log("Starting server...");
  await run(`sandbox-agent server --no-token --host 0.0.0.0 --port ${PORT}`, { background: true });

  const baseUrl = await sandbox.getUrl({ port: PORT });

  console.log("Waiting for server...");
  await waitForHealth({ baseUrl });

  const cleanup = async () => {
    try {
      await sandbox.destroy();
    } catch (error) {
      console.warn("Cleanup failed:", error instanceof Error ? error.message : error);
    }
  };

  return { baseUrl, cleanup };
}

export async function runComputeSdkExample(): Promise<void> {
  const { baseUrl, cleanup } = await setupComputeSdkSandboxAgent();

  const handleExit = async () => {
    await cleanup();
    process.exit(0);
  };

  process.once("SIGINT", handleExit);
  process.once("SIGTERM", handleExit);

  const client = await SandboxAgent.connect({ baseUrl });
  const session = await client.createSession({ agent: detectAgent(), sessionInit: { cwd: "/root", mcpServers: [] } });
  const sessionId = session.id;

  console.log(`  UI: ${buildInspectorUrl({ baseUrl, sessionId })}`);
  console.log("  Press Ctrl+C to stop.");

  // Keep alive until SIGINT/SIGTERM triggers cleanup above
  await new Promise(() => {});
}

const isDirectRun = Boolean(
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
);

if (isDirectRun) {
  runComputeSdkExample().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
