import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.cwd(), "src/generated/openapi.ts");
let source = readFileSync(target, "utf8");

// McpCommand, McpOAuthConfigOrDisabled, and McpRemoteTransport are now
// properly defined in the OpenAPI spec, so openapi-typescript generates
// correct types for them directly. No patching needed.
const replacements = [];

for (const [from, to] of replacements) {
  source = source.split(from).join(to);
}

writeFileSync(target, source);
