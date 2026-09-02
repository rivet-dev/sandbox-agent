import { detectAgent } from "@sandbox-agent/example-shared";
import { SandboxAgent } from "sandbox-agent";
import { sprites } from "sandbox-agent/sprites";

const env: Record<string, string> = {};
if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const agent = detectAgent();

const client = await SandboxAgent.start({
  // ✨ NEW ✨
  sandbox: sprites({
    token: process.env.SPRITES_TOKEN ?? process.env.SPRITES_API_KEY,
    env,
    installAgents: [agent],
  }),
});

console.log(`UI: ${client.inspectorUrl}`);

const session = await client.createSession({ agent });

session.onEvent((event) => {
  console.log(`[${event.sender}]`, JSON.stringify(event.payload));
});

session.prompt([{ type: "text", text: "Say hello from Sprites in one sentence." }]);

process.once("SIGINT", async () => {
  await client.destroySandbox();
  process.exit(0);
});
