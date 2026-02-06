import { SandboxAgent } from "sandbox-agent";
import { runPrompt } from "@sandbox-agent/example-shared";
import { startDockerSandbox } from "@sandbox-agent/example-shared/docker";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Step 1: Verify script bundle exists (built by `pnpm build:script`)
const scriptFile = path.resolve(__dirname, "../dist/greeter.cjs");
if (!fs.existsSync(scriptFile)) {
  console.error("Error: dist/greeter.cjs not found. Run `pnpm build:script` first.");
  process.exit(1);
}
console.log("Step 1: Script bundle ready at dist/greeter.cjs");

// Step 2: Start Docker container with sandbox-agent + Node.js
console.log("Step 2: Starting Docker container...");
const { baseUrl, cleanup } = await startDockerSandbox({ port: 3001, packages: ["nodejs"] });

// Step 3: Upload bundled script and SKILL.md to sandbox
console.log("Step 3: Uploading skill files...");
const client = await SandboxAgent.connect({ baseUrl });

const script = await fs.promises.readFile(scriptFile);
const scriptResult = await client.writeFsFile(
  { path: "/opt/skills/greeter/greeter.cjs" },
  script,
);
console.log(`  Script: ${scriptResult.path} (${scriptResult.bytesWritten} bytes)`);

const skillMd = await fs.promises.readFile(path.resolve(__dirname, "../SKILL.md"));
const skillResult = await client.writeFsFile(
  { path: "/opt/skills/greeter/SKILL.md" },
  skillMd,
);
console.log(`  Skill:  ${skillResult.path} (${skillResult.bytesWritten} bytes)`);

// Step 4: Start interactive session with skill
console.log("Step 4: Creating session with greeter skill...");
console.log('  Try: "greet Alice"');
await runPrompt(baseUrl, {
  skills: {
    paths: ["/opt/skills/greeter"],
  },
});
await cleanup();
