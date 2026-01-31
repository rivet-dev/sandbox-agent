import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { fetchWithCache } from "./cache.js";
import { createNormalizedSchema, openApiToJsonSchema, type NormalizedSchema } from "./normalize.js";
import type { JSONSchema7 } from "json-schema";

const OPENAPI_URLS = [
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/openapi.json",
  "https://raw.githubusercontent.com/sst/opencode/dev/packages/sdk/openapi.json",
];

// Key schemas we want to extract
const TARGET_SCHEMAS = [
  "Session",
  "Message",
  "Part",
  "Event",
  "PermissionRequest",
  "QuestionRequest",
  "TextPart",
  "ToolCallPart",
  "ToolResultPart",
  "ErrorPart",
];

const OPENAPI_ARTIFACT_DIR = join(import.meta.dirname, "..", "artifacts", "openapi");
const OPENAPI_ARTIFACT_PATH = join(OPENAPI_ARTIFACT_DIR, "opencode.json");

interface OpenAPISpec {
  components?: {
    schemas?: Record<string, unknown>;
  };
}

function writeOpenApiArtifact(specText: string): void {
  if (!existsSync(OPENAPI_ARTIFACT_DIR)) {
    mkdirSync(OPENAPI_ARTIFACT_DIR, { recursive: true });
  }
  writeFileSync(OPENAPI_ARTIFACT_PATH, specText);
  console.log(`  [wrote] ${OPENAPI_ARTIFACT_PATH}`);
}

export async function extractOpenCodeSchema(): Promise<NormalizedSchema> {
  console.log("Extracting OpenCode schema from OpenAPI spec...");

  let specText: string | null = null;
  let lastError: Error | null = null;
  for (const url of OPENAPI_URLS) {
    try {
      specText = await fetchWithCache(url);
      break;
    } catch (error) {
      lastError = error as Error;
    }
  }
  if (!specText) {
    throw lastError ?? new Error("Failed to fetch OpenCode OpenAPI spec");
  }
  writeOpenApiArtifact(specText);
  const spec: OpenAPISpec = JSON.parse(specText);

  if (!spec.components?.schemas) {
    throw new Error("OpenAPI spec missing components.schemas");
  }

  const definitions: Record<string, JSONSchema7> = {};

  // Extract all schemas, not just target ones, to preserve references
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    definitions[name] = openApiToJsonSchema(schema as Record<string, unknown>);
  }

  // Verify target schemas exist
  const missing = TARGET_SCHEMAS.filter((name) => !definitions[name]);
  if (missing.length > 0) {
    console.warn(`  [warn] Missing expected schemas: ${missing.join(", ")}`);
  }

  const found = TARGET_SCHEMAS.filter((name) => definitions[name]);
  console.log(`  [ok] Extracted ${Object.keys(definitions).length} schemas (${found.length} target schemas)`);

  return createNormalizedSchema("opencode", "OpenCode SDK Schema", definitions);
}
