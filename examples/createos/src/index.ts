import { detectAgent } from "@sandbox-agent/example-shared";
import { SandboxAgent } from "sandbox-agent";
import { createos } from "sandbox-agent/createos";

const envs: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) envs.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) envs.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const client = await SandboxAgent.start({
  // ✨ NEW ✨
  sandbox: createos({
    client: { apiKey: process.env.CREATEOS_API_KEY },
    ...(process.env.CREATEOS_SHAPE ? { shape: process.env.CREATEOS_SHAPE } : {}),
    create: { envs },
  }),
});

const session = await client.createSession({
  agent: detectAgent(),
});

session.onEvent((event) => {
  console.log(`[${event.sender}]`, JSON.stringify(event.payload));
});

session.prompt([{ type: "text", text: "Say hello from createos in one sentence." }]);

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
