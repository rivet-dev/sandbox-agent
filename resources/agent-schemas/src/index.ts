import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { extractOpenCodeSchema } from "./opencode.js";
import { extractClaudeSchema } from "./claude.js";
import { extractCodexSchema } from "./codex.js";
import { extractAmpSchema } from "./amp.js";
import { extractPiSchema } from "./pi.js";
import { validateSchema, type NormalizedSchema } from "./normalize.js";

const RESOURCE_DIR = join(import.meta.dirname, "..");
const DIST_DIR = join(RESOURCE_DIR, "artifacts", "json-schema");

type AgentName = "opencode" | "claude" | "codex" | "amp" | "pi";

const EXTRACTORS: Record<AgentName, () => Promise<NormalizedSchema>> = {
  opencode: extractOpenCodeSchema,
  claude: extractClaudeSchema,
  codex: extractCodexSchema,
  amp: extractAmpSchema,
  pi: extractPiSchema,
};

function parseArgs(): { agents: AgentName[] } {
  const args = process.argv.slice(2);
  const agentArg = args.find((arg) => arg.startsWith("--agent="));

  if (agentArg) {
    const agent = agentArg.split("=")[1] as AgentName;
    if (!EXTRACTORS[agent]) {
      console.error(`Unknown agent: ${agent}`);
      console.error(`Valid agents: ${Object.keys(EXTRACTORS).join(", ")}`);
      process.exit(1);
    }
    return { agents: [agent] };
  }

  return { agents: Object.keys(EXTRACTORS) as AgentName[] };
}

function ensureDistDir(): void {
  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }
}

async function extractAndWrite(agent: AgentName): Promise<boolean> {
  try {
    const extractor = EXTRACTORS[agent];
    const schema = await extractor();

    // Validate schema
    const validation = validateSchema(schema);
    if (!validation.valid) {
      console.error(`  [error] Schema validation failed for ${agent}:`);
      validation.errors.forEach((err) => console.error(`    - ${err}`));
      return false;
    }

    // Write to file
    const outputPath = join(DIST_DIR, `${agent}.json`);
    writeFileSync(outputPath, JSON.stringify(schema, null, 2));
    console.log(`  [wrote] ${outputPath}`);

    return true;
  } catch (error) {
    console.error(`  [error] Failed to extract ${agent}: ${error}`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("Agent Schema Extractor");
  console.log("======================\n");

  const { agents } = parseArgs();
  ensureDistDir();

  console.log(`Extracting schemas for: ${agents.join(", ")}\n`);

  const results: Record<string, boolean> = {};

  for (const agent of agents) {
    results[agent] = await extractAndWrite(agent);
    console.log();
  }

  // Summary
  console.log("Summary");
  console.log("-------");

  const successful = Object.entries(results)
    .filter(([, success]) => success)
    .map(([name]) => name);
  const failed = Object.entries(results)
    .filter(([, success]) => !success)
    .map(([name]) => name);

  if (successful.length > 0) {
    console.log(`Successful: ${successful.join(", ")}`);
  }
  if (failed.length > 0) {
    console.log(`Failed: ${failed.join(", ")}`);
    process.exit(1);
  }

  console.log("\nDone!");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
