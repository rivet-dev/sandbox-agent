import { SandboxAgent } from "sandbox-agent";
import { runPrompt } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";

// A self-contained MCP echo server (raw JSON-RPC, no npm deps required)
const ECHO_SERVER_JS = `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });

const PREFIX = process.env.PREFIX || "[echo] ";

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "echo", version: "1.0.0" },
    }});
  } else if (method === "notifications/initialized") {
    // no response needed
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "echo",
      description: "Echo back the input with a prefix",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    }]}});
  } else if (method === "tools/call") {
    const text = params?.arguments?.text || "";
    send({ jsonrpc: "2.0", id, result: {
      content: [{ type: "text", text: PREFIX + text }],
    }});
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

// Step 1: Start Docker container with sandbox-agent + Node.js
console.log("Step 1: Starting Docker container...");
const { baseUrl, cleanup } = await startDockerSandbox({ port: 3002, packages: ["nodejs"] });

// Step 2: Upload the echo MCP server script
console.log("Step 2: Uploading echo MCP server...");
const client = await SandboxAgent.connect({ baseUrl });

const written = await client.writeFsFile(
  { path: "/opt/mcp/echo-server/echo-server.js" },
  ECHO_SERVER_JS,
  { contentType: "application/javascript" },
);
console.log(`  Written: ${written.path} (${written.bytesWritten} bytes)`);

// Step 3: Start interactive session with MCP echo server
console.log("Step 3: Creating session with echo MCP server...");
console.log('  Try: "echo hello world"');
await runPrompt(baseUrl, {
  mcp: {
    echo: {
      type: "local",
      command: ["node", "/opt/mcp/echo-server/echo-server.js"],
      env: { PREFIX: "[ECHO] " },
      timeoutMs: 10000,
    },
  },
});
await cleanup();
