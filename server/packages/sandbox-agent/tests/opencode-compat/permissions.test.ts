/**
 * Tests for OpenCode-compatible permission endpoints.
 *
 * These tests verify that sandbox-agent exposes OpenCode-compatible permission
 * handling endpoints that can be used with the official OpenCode SDK.
 *
 * Expected endpoints:
 * - POST /session/{id}/permissions/{permissionID} - Respond to a permission request
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Permission API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let sessionId: string;

  beforeAll(async () => {
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    handle = await spawnSandboxAgent({ opencodeCompat: true });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });

    // Create a session
    const session = await client.session.create();
    sessionId = session.data?.id!;
    expect(sessionId).toBeDefined();
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  const permissionPrompt = "permission";

  async function waitForPermissionRequest(timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const list = await client.permission.list();
      const request = list.data?.[0];
      if (request) {
        return request;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Timed out waiting for permission request");
  }

  describe("permission.reply (global)", () => {
    it("should receive permission.asked and reply via global endpoint", async () => {
      await client.session.prompt({
        sessionID: sessionId,
        model: { providerID: "sandbox-agent", modelID: "mock" },
        parts: [{ type: "text", text: permissionPrompt }],
      });

      const asked = await waitForPermissionRequest();
      const requestId = asked?.id;
      expect(requestId).toBeDefined();

      const response = await client.permission.reply({
        requestID: requestId,
        reply: "once",
      });
      expect(response.error).toBeUndefined();
    });
  });

  describe("postSessionIdPermissionsPermissionId (session)", () => {
    it("should accept permission response for a session", async () => {
      await client.session.prompt({
        sessionID: sessionId,
        model: { providerID: "sandbox-agent", modelID: "mock" },
        parts: [{ type: "text", text: permissionPrompt }],
      });

      const asked = await waitForPermissionRequest();
      const requestId = asked?.id;
      expect(requestId).toBeDefined();

      const response = await client.permission.respond({
        sessionID: sessionId,
        permissionID: requestId,
        response: "allow",
      });

      expect(response.error).toBeUndefined();
    });
  });
});
