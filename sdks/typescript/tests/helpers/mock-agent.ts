import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function prepareMockAgentDataHome(dataHome: string): void {
  const installDir = join(dataHome, "sandbox-agent", "bin");
  const processDir = join(installDir, "agent_processes");
  mkdirSync(processDir, { recursive: true });

  const runner = process.platform === "win32"
    ? join(processDir, "mock-acp.cmd")
    : join(processDir, "mock-acp");

  const scriptFile = process.platform === "win32"
    ? join(processDir, "mock-acp.js")
    : runner;

  const nodeScript = String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");

let nextSession = 0;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function firstText(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }

  for (const block of prompt) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }

  return "";
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const hasMethod = typeof msg?.method === "string";
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const method = hasMethod ? msg.method : undefined;

  if (method === "session/prompt") {
    const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : "";
    const text = firstText(msg?.params?.prompt);
    emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "mock: " + text,
          },
        },
      },
    });
  }

  if (!hasMethod || !hasId) {
    return;
  }

  if (method === "initialize") {
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        capabilities: {},
        serverInfo: {
          name: "mock-acp-agent",
          version: "0.0.1",
        },
      },
    });
    return;
  }

  if (method === "session/new") {
    nextSession += 1;
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "mock-session-" + nextSession,
      },
    });
    return;
  }

  if (method === "session/prompt") {
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        stopReason: "end_turn",
      },
    });
    return;
  }

  emit({
    jsonrpc: "2.0",
    id: msg.id,
    result: {
      ok: true,
      echoedMethod: method,
    },
  });
});
`;

  writeFileSync(scriptFile, nodeScript);

  if (process.platform === "win32") {
    writeFileSync(runner, `@echo off\r\nnode "${scriptFile}" %*\r\n`);
  }

  chmodSync(scriptFile, 0o755);
  if (process.platform === "win32") {
    chmodSync(runner, 0o755);
  }
}
