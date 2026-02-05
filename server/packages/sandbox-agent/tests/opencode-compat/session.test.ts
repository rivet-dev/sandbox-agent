/**
 * Tests for OpenCode-compatible session management endpoints.
 *
 * These tests verify that sandbox-agent exposes OpenCode-compatible API endpoints
 * that can be used with the official OpenCode SDK.
 *
 * Expected endpoints:
 * - POST /session - Create a new session
 * - GET /session - List all sessions
 * - GET /session/{id} - Get session details
 * - PATCH /session/{id} - Update session properties
 * - DELETE /session/{id} - Delete a session
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { spawnSandboxAgent, buildSandboxAgent, type SandboxAgentHandle } from "./helpers/spawn";

describe("OpenCode-compatible Session API", () => {
  let handle: SandboxAgentHandle;
  let client: OpencodeClient;
  let stateDir: string;

  beforeAll(async () => {
    // Build the binary if needed
    await buildSandboxAgent();
  });

  beforeEach(async () => {
    // Spawn a fresh sandbox-agent instance for each test
    stateDir = await mkdtemp(join(tmpdir(), "opencode-state-"));
    handle = await spawnSandboxAgent({
      opencodeCompat: true,
      env: { OPENCODE_COMPAT_STATE: stateDir },
    });
    client = createOpencodeClient({
      baseUrl: `${handle.baseUrl}/opencode`,
      headers: { Authorization: `Bearer ${handle.token}` },
    });
  });

  afterEach(async () => {
    await handle?.dispose();
  });

  describe("session.create", () => {
    it("should create a new session", async () => {
      const response = await client.session.create();

      expect(response.data).toBeDefined();
      expect(response.data?.id).toBeDefined();
      expect(typeof response.data?.id).toBe("string");
      expect(response.data?.id.length).toBeGreaterThan(0);
    });

    it("should create session with custom title", async () => {
      const response = await client.session.create({
        body: { title: "Test Session" },
      });

      expect(response.data).toBeDefined();
      expect(response.data?.title).toBe("Test Session");
    });

    it("should assign unique IDs to each session", async () => {
      const session1 = await client.session.create();
      const session2 = await client.session.create();

      expect(session1.data?.id).not.toBe(session2.data?.id);
    });
  });

  describe("session.list", () => {
    it("should return empty list when no sessions exist", async () => {
      const response = await client.session.list();

      expect(response.data).toBeDefined();
      expect(Array.isArray(response.data)).toBe(true);
      expect(response.data?.length).toBe(0);
    });

    it("should list created sessions", async () => {
      // Create some sessions
      await client.session.create({ body: { title: "Session 1" } });
      await client.session.create({ body: { title: "Session 2" } });

      const response = await client.session.list();

      expect(response.data).toBeDefined();
      expect(response.data?.length).toBe(2);
    });
  });

  describe("session.get", () => {
    it("should retrieve session by ID", async () => {
      const created = await client.session.create({ body: { title: "Test" } });
      const sessionId = created.data?.id;
      expect(sessionId).toBeDefined();

      const response = await client.session.get({ path: { id: sessionId! } });

      expect(response.data).toBeDefined();
      expect(response.data?.id).toBe(sessionId);
      expect(response.data?.title).toBe("Test");
    });

    it("should return error for non-existent session", async () => {
      const response = await client.session.get({
        path: { id: "non-existent-session-id" },
      });

      expect(response.error).toBeDefined();
    });
  });

  describe("session.update", () => {
    it("should update session title", async () => {
      const created = await client.session.create({ body: { title: "Original" } });
      const sessionId = created.data?.id!;

      await client.session.update({
        path: { id: sessionId },
        body: { title: "Updated" },
      });

      const response = await client.session.get({ path: { id: sessionId } });
      expect(response.data?.title).toBe("Updated");
    });
  });

  describe("session.delete", () => {
    it("should delete a session", async () => {
      const created = await client.session.create();
      const sessionId = created.data?.id!;

      await client.session.delete({ path: { id: sessionId } });

      const response = await client.session.get({ path: { id: sessionId } });
      expect(response.error).toBeDefined();
    });

    it("should not affect other sessions when one is deleted", async () => {
      const session1 = await client.session.create({ body: { title: "Keep" } });
      const session2 = await client.session.create({ body: { title: "Delete" } });

      await client.session.delete({ path: { id: session2.data?.id! } });

      const response = await client.session.get({ path: { id: session1.data?.id! } });
      expect(response.data).toBeDefined();
      expect(response.data?.title).toBe("Keep");
    });
  });

  describe("session.persistence", () => {
    it("should persist sessions across restarts", async () => {
      const created = await client.session.create({ body: { title: "Persistent" } });
      const sessionId = created.data?.id!;

      await client.session.update({
        path: { id: sessionId },
        body: { title: "Updated" },
      });

      await fetch(`${handle.baseUrl}/opencode/session/${sessionId}/share`, {
        method: "POST",
        headers: { Authorization: `Bearer ${handle.token}` },
      });

      await handle.dispose();

      handle = await spawnSandboxAgent({
        opencodeCompat: true,
        env: { OPENCODE_COMPAT_STATE: stateDir },
      });
      client = createOpencodeClient({
        baseUrl: `${handle.baseUrl}/opencode`,
        headers: { Authorization: `Bearer ${handle.token}` },
      });

      const list = await client.session.list();
      const persisted = list.data?.find((session) => session.id === sessionId);
      expect(persisted).toBeDefined();
      expect(persisted?.title).toBe("Updated");
      expect(persisted?.share?.url).toContain(sessionId);

      const next = await client.session.create();
      expect(next.data?.id).not.toBe(sessionId);
    });
  });
});
