import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  SandboxAgent,
  type PermissionReply,
  type SessionPermissionRequest,
} from "sandbox-agent";

const permissionMode = process.env.CLAUDE_PERMISSION_MODE?.trim() || "default";
const autoReply = parsePermissionReply(process.env.CLAUDE_PERMISSION_REPLY);
const promptText =
  process.env.CLAUDE_PERMISSION_PROMPT?.trim() ||
  "Create ./permission-example.txt with the text 'hello from Claude permissions example'.";

const sdk = await SandboxAgent.start({
  spawn: {
    enabled: true,
    log: "inherit",
  },
});

try {
  await sdk.installAgent("claude");

  const agents = await sdk.listAgents({ config: true });
  const claude = agents.agents.find((agent) => agent.id === "claude");
  const configOptions = Array.isArray(claude?.configOptions)
    ? (claude.configOptions as Array<{ category?: string; options?: unknown[] }>)
    : [];
  const modeOption = configOptions.find((option) => option.category === "mode");
  const availableModes = extractOptionValues(modeOption);

  console.log(`Claude permission mode: ${permissionMode}`);
  if (availableModes.length > 0) {
    console.log(`Available Claude modes: ${availableModes.join(", ")}`);
  }
  console.log(`Working directory: ${process.cwd()}`);
  console.log(`Prompt: ${promptText}`);
  if (autoReply) {
    console.log(`Automatic permission reply: ${autoReply}`);
  } else {
    console.log("Interactive permission replies enabled.");
  }

  const session = await sdk.createSession({
    agent: "claude",
    permissionMode,
    sessionInit: {
      cwd: process.cwd(),
      mcpServers: [],
    },
  });

  const rl = autoReply
    ? null
    : createInterface({
        input,
        output,
      });

  session.onPermissionRequest((request: SessionPermissionRequest) => {
    void handlePermissionRequest(session, request, autoReply, rl);
  });

  const response = await session.prompt([{ type: "text", text: promptText }]);
  console.log(`Prompt finished with stopReason=${response.stopReason}`);

  await rl?.close();
} finally {
  await sdk.dispose();
}

async function handlePermissionRequest(
  session: {
    replyPermission(permissionId: string, reply: PermissionReply): Promise<void>;
  },
  request: SessionPermissionRequest,
  auto: PermissionReply | null,
  rl: ReturnType<typeof createInterface> | null,
): Promise<void> {
  const reply = auto ?? (await promptForReply(request, rl));
  console.log(`Permission ${reply}: ${request.toolCall.title ?? request.toolCall.toolCallId}`);
  await session.replyPermission(request.id, reply);
}

async function promptForReply(
  request: SessionPermissionRequest,
  rl: ReturnType<typeof createInterface> | null,
): Promise<PermissionReply> {
  if (!rl) {
    return "reject";
  }

  const title = request.toolCall.title ?? request.toolCall.toolCallId;
  const available = request.availableReplies;
  console.log("");
  console.log(`Permission request: ${title}`);
  console.log(`Available replies: ${available.join(", ")}`);
  const answer = (await rl.question("Reply [once|always|reject]: ")).trim().toLowerCase();
  const parsed = parsePermissionReply(answer);
  if (parsed && available.includes(parsed)) {
    return parsed;
  }

  console.log("Invalid reply, defaulting to reject.");
  return "reject";
}

function extractOptionValues(option: { options?: unknown[] } | undefined): string[] {
  if (!option?.options) {
    return [];
  }

  const values: string[] = [];
  for (const entry of option.options) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const value = "value" in entry && typeof entry.value === "string" ? entry.value : null;
    if (value) {
      values.push(value);
      continue;
    }
    if (!("options" in entry) || !Array.isArray(entry.options)) {
      continue;
    }
    for (const nested of entry.options) {
      if (!nested || typeof nested !== "object") {
        continue;
      }
      const nestedValue =
        "value" in nested && typeof nested.value === "string" ? nested.value : null;
      if (nestedValue) {
        values.push(nestedValue);
      }
    }
  }

  return [...new Set(values)];
}

function parsePermissionReply(value: string | undefined): PermissionReply | null {
  if (!value) {
    return null;
  }

  switch (value.trim().toLowerCase()) {
    case "once":
      return "once";
    case "always":
      return "always";
    case "reject":
    case "deny":
      return "reject";
    default:
      return null;
  }
}
