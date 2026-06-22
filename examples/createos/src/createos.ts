import { SandboxAgent } from "sandbox-agent";
import { createos } from "sandbox-agent/createos";

function collectEnvVars(): Record<string, string> {
  const envs: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  return envs;
}

function inspectorUrlToBaseUrl(inspectorUrl: string): string {
  return inspectorUrl.replace(/\/ui\/$/, "");
}

export async function setupCreateosSandboxAgent(): Promise<{
  baseUrl: string;
  token?: string;
  cleanup: () => Promise<void>;
}> {
  const client = await SandboxAgent.start({
    sandbox: createos({
      client: { apiKey: process.env.CREATEOS_API_KEY },
      ...(process.env.CREATEOS_SHAPE ? { shape: process.env.CREATEOS_SHAPE } : {}),
      ...(process.env.CREATEOS_ROOTFS ? { rootfs: process.env.CREATEOS_ROOTFS } : {}),
      create: { envs: collectEnvVars() },
    }),
  });

  return {
    baseUrl: inspectorUrlToBaseUrl(client.inspectorUrl),
    cleanup: async () => {
      await client.killSandbox();
    },
  };
}
