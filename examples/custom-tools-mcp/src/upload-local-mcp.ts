import { SandboxAgent } from "sandbox-agent";
import { runPrompt } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Step 1: Verify MCP server bundle exists (built by `pnpm build:mcp`)
const serverFile = path.resolve(__dirname, "../dist/mcp-server.cjs");
if (!fs.existsSync(serverFile)) {
  console.error("Error: dist/mcp-server.cjs not found. Run `pnpm build:mcp` first.");
  process.exit(1);
}
console.log("Step 1: MCP server bundle ready at dist/mcp-server.cjs");

// Step 2: Start Docker container with sandbox-agent + Node.js
console.log("Step 2: Starting Docker container...");
const { baseUrl, cleanup } = await startDockerSandbox({ port: 3004, packages: ["nodejs"] });

// Step 3: Upload bundled MCP server to sandbox
console.log("Step 3: Uploading MCP server bundle...");
const client = await SandboxAgent.connect({ baseUrl });

const bundle = await fs.promises.readFile(serverFile);
const written = await client.writeFsFile(
  { path: "/opt/mcp/custom-tools/mcp-server.cjs" },
  bundle,
  { contentType: "application/javascript" },
);
console.log(`  Written: ${written.path} (${written.bytesWritten} bytes)`);

// Step 4: Start interactive session with MCP tool
console.log("Step 4: Creating session with custom MCP tool...");
console.log('  Try: "generate a random number between 1 and 100"');
await runPrompt(baseUrl, {
  mcp: {
    customTools: {
      type: "local",
      command: ["node", "/opt/mcp/custom-tools/mcp-server.cjs"],
    },
  },
});
await cleanup();
