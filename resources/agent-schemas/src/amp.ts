import * as cheerio from "cheerio";
import { fetchWithCache } from "./cache.js";
import { createNormalizedSchema, type NormalizedSchema } from "./normalize.js";
import type { JSONSchema7 } from "json-schema";

const AMP_DOCS_URL = "https://ampcode.com/manual/appendix?preview#message-schema";

// Key types we want to extract
const TARGET_TYPES = ["StreamJSONMessage", "AmpOptions", "PermissionRule", "Message", "ToolCall"];

export async function extractAmpSchema(): Promise<NormalizedSchema> {
  console.log("Extracting AMP schema from documentation...");

  try {
    const html = await fetchWithCache(AMP_DOCS_URL);
    const $ = cheerio.load(html);

    // Find TypeScript code blocks
    const codeBlocks: string[] = [];
    $("pre code").each((_, el) => {
      const code = $(el).text();
      // Look for TypeScript interface/type definitions
      if (
        code.includes("interface ") ||
        code.includes("type ") ||
        code.includes(": {") ||
        code.includes("export ")
      ) {
        codeBlocks.push(code);
      }
    });

    if (codeBlocks.length === 0) {
      console.log("  [warn] No TypeScript code blocks found, using fallback schema");
      return createFallbackSchema();
    }

    console.log(`  [found] ${codeBlocks.length} code blocks`);

    // Parse TypeScript definitions into schemas
    const definitions = parseTypeScriptToSchema(codeBlocks.join("\n"));

    // Verify target types exist
    const found = TARGET_TYPES.filter((name) => definitions[name]);
    const missing = TARGET_TYPES.filter((name) => !definitions[name]);

    if (missing.length > 0) {
      console.log(`  [warn] Missing expected types: ${missing.join(", ")}`);
    }

    if (Object.keys(definitions).length === 0) {
      console.log("  [warn] No types extracted, using fallback schema");
      return createFallbackSchema();
    }

    console.log(`  [ok] Extracted ${Object.keys(definitions).length} types (${found.length} target types)`);

    return createNormalizedSchema("amp", "AMP Code SDK Schema", definitions);
  } catch (error) {
    console.log(`  [error] Failed to fetch docs: ${error}`);
    console.log("  [fallback] Using embedded schema definitions");
    return createFallbackSchema();
  }
}

function parseTypeScriptToSchema(code: string): Record<string, JSONSchema7> {
  const definitions: Record<string, JSONSchema7> = {};

  // Match interface definitions
  const interfaceRegex = /(?:export\s+)?interface\s+(\w+)\s*(?:extends\s+[\w,\s]+)?\s*\{([^}]+)\}/g;
  let match;

  while ((match = interfaceRegex.exec(code)) !== null) {
    const [, name, body] = match;
    definitions[name] = parseInterfaceBody(body);
  }

  // Match type definitions (simple object types)
  const typeRegex = /(?:export\s+)?type\s+(\w+)\s*=\s*\{([^}]+)\}/g;

  while ((match = typeRegex.exec(code)) !== null) {
    const [, name, body] = match;
    definitions[name] = parseInterfaceBody(body);
  }

  // Match union type definitions
  const unionRegex = /(?:export\s+)?type\s+(\w+)\s*=\s*([^;{]+);/g;

  while ((match = unionRegex.exec(code)) !== null) {
    const [, name, body] = match;
    if (body.includes("|")) {
      definitions[name] = parseUnionType(body);
    }
  }

  return definitions;
}

function parseInterfaceBody(body: string): JSONSchema7 {
  const properties: Record<string, JSONSchema7> = {};
  const required: string[] = [];

  // Match property definitions
  const propRegex = /(\w+)(\?)?:\s*([^;]+);/g;
  let match;

  while ((match = propRegex.exec(body)) !== null) {
    const [, propName, optional, propType] = match;
    properties[propName] = typeToSchema(propType.trim());

    if (!optional) {
      required.push(propName);
    }
  }

  const schema: JSONSchema7 = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}

function typeToSchema(tsType: string): JSONSchema7 {
  // Handle union types
  if (tsType.includes("|")) {
    return parseUnionType(tsType);
  }

  // Handle array types
  if (tsType.endsWith("[]")) {
    const itemType = tsType.slice(0, -2);
    return {
      type: "array",
      items: typeToSchema(itemType),
    };
  }

  // Handle Array<T>
  const arrayMatch = tsType.match(/^Array<(.+)>$/);
  if (arrayMatch) {
    return {
      type: "array",
      items: typeToSchema(arrayMatch[1]),
    };
  }

  // Handle basic types
  switch (tsType) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "any":
    case "unknown":
      return {};
    case "object":
      return { type: "object" };
    default:
      // Could be a reference to another type
      if (/^[A-Z]/.test(tsType)) {
        return { $ref: `#/definitions/${tsType}` };
      }
      // String literal
      if (tsType.startsWith('"') || tsType.startsWith("'")) {
        return { type: "string", const: tsType.slice(1, -1) };
      }
      return { type: "string" };
  }
}

function parseUnionType(unionStr: string): JSONSchema7 {
  const parts = unionStr.split("|").map((p) => p.trim());

  // Check if it's a string literal union
  const allStringLiterals = parts.every((p) => p.startsWith('"') || p.startsWith("'"));

  if (allStringLiterals) {
    return {
      type: "string",
      enum: parts.map((p) => p.slice(1, -1)),
    };
  }

  // General union
  return {
    oneOf: parts.map((p) => typeToSchema(p)),
  };
}

function createFallbackSchema(): NormalizedSchema {
  // Fallback schema based on AMP documentation structure
  const definitions: Record<string, JSONSchema7> = {
    StreamJSONMessage: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["system", "user", "assistant", "result", "message", "tool_call", "tool_result", "error", "done"],
        },
        // Common fields
        id: { type: "string" },
        content: { type: "string" },
        tool_call: { $ref: "#/definitions/ToolCall" },
        error: { type: "string" },
        // System message fields
        subtype: { type: "string" },
        cwd: { type: "string" },
        session_id: { type: "string" },
        tools: { type: "array", items: { type: "string" } },
        mcp_servers: { type: "array", items: { type: "object" } },
        // User/Assistant message fields
        message: { type: "object" },
        parent_tool_use_id: { type: "string" },
        // Result fields
        duration_ms: { type: "number" },
        is_error: { type: "boolean" },
        num_turns: { type: "number" },
        result: { type: "string" },
      },
      required: ["type"],
    },
    AmpOptions: {
      type: "object",
      properties: {
        model: { type: "string" },
        apiKey: { type: "string" },
        baseURL: { type: "string" },
        maxTokens: { type: "number" },
        temperature: { type: "number" },
        systemPrompt: { type: "string" },
        tools: { type: "array", items: { type: "object" } },
        workingDirectory: { type: "string" },
        permissionRules: {
          type: "array",
          items: { $ref: "#/definitions/PermissionRule" },
        },
      },
    },
    PermissionRule: {
      type: "object",
      properties: {
        tool: { type: "string" },
        action: { type: "string", enum: ["allow", "deny", "ask"] },
        pattern: { type: "string" },
        description: { type: "string" },
      },
      required: ["tool", "action"],
    },
    Message: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["user", "assistant", "system"] },
        content: { type: "string" },
        tool_calls: {
          type: "array",
          items: { $ref: "#/definitions/ToolCall" },
        },
      },
      required: ["role", "content"],
    },
    ToolCall: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        arguments: {
          oneOf: [{ type: "string" }, { type: "object" }],
        },
      },
      required: ["id", "name", "arguments"],
    },
  };

  console.log(`  [ok] Using fallback schema with ${Object.keys(definitions).length} definitions`);

  return createNormalizedSchema("amp", "AMP Code SDK Schema", definitions);
}
