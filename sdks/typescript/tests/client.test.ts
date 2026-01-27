import { describe, it, expect, vi, type Mock } from "vitest";
import { SandboxDaemonClient, SandboxDaemonError } from "../src/client.ts";

function createMockFetch(
  response: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Mock<typeof fetch> {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    })
  );
}

function createMockFetchError(status: number, problem: unknown): Mock<typeof fetch> {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(problem), {
      status,
      headers: { "Content-Type": "application/problem+json" },
    })
  );
}

describe("SandboxDaemonClient", () => {
  describe("constructor", () => {
    it("creates client with baseUrl", () => {
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
      });
      expect(client).toBeInstanceOf(SandboxDaemonClient);
    });

    it("strips trailing slash from baseUrl", async () => {
      const mockFetch = createMockFetch({ status: "ok" });
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080/",
        fetch: mockFetch,
      });

      await client.getHealth();

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/health",
        expect.any(Object)
      );
    });

    it("throws if fetch is not available", () => {
      const originalFetch = globalThis.fetch;
      // @ts-expect-error - testing missing fetch
      globalThis.fetch = undefined;

      expect(() => {
        new SandboxDaemonClient({
          baseUrl: "http://localhost:8080",
        });
      }).toThrow("Fetch API is not available");

      globalThis.fetch = originalFetch;
    });
  });

  describe("connect", () => {
    it("creates client without spawn when baseUrl provided", async () => {
      const client = await SandboxDaemonClient.connect({
        baseUrl: "http://localhost:8080",
        spawn: false,
      });
      expect(client).toBeInstanceOf(SandboxDaemonClient);
    });

    it("throws when no baseUrl and spawn disabled", async () => {
      await expect(
        SandboxDaemonClient.connect({ spawn: false })
      ).rejects.toThrow("baseUrl is required when autospawn is disabled");
    });
  });

  describe("getHealth", () => {
    it("returns health response", async () => {
      const mockFetch = createMockFetch({ status: "ok" });
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      const result = await client.getHealth();

      expect(result).toEqual({ status: "ok" });
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/health",
        expect.objectContaining({ method: "GET" })
      );
    });
  });

  describe("listAgents", () => {
    it("returns agent list", async () => {
      const agents = { agents: [{ id: "claude", installed: true }] };
      const mockFetch = createMockFetch(agents);
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      const result = await client.listAgents();

      expect(result).toEqual(agents);
    });
  });

  describe("createSession", () => {
    it("creates session with agent", async () => {
      const response = { healthy: true, agentSessionId: "abc123" };
      const mockFetch = createMockFetch(response);
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      const result = await client.createSession("test-session", {
        agent: "claude",
      });

      expect(result).toEqual(response);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/sessions/test-session",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ agent: "claude" }),
        })
      );
    });

    it("encodes session ID in URL", async () => {
      const mockFetch = createMockFetch({ healthy: true });
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      await client.createSession("test/session", { agent: "claude" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/sessions/test%2Fsession",
        expect.any(Object)
      );
    });
  });

  describe("postMessage", () => {
    it("sends message to session", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 204 })
      );
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      await client.postMessage("test-session", { message: "Hello" });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/sessions/test-session/messages",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ message: "Hello" }),
        })
      );
    });
  });

  describe("getEvents", () => {
    it("returns events", async () => {
      const events = { events: [], hasMore: false };
      const mockFetch = createMockFetch(events);
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      const result = await client.getEvents("test-session");

      expect(result).toEqual(events);
    });

    it("passes query parameters", async () => {
      const mockFetch = createMockFetch({ events: [], hasMore: false });
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      await client.getEvents("test-session", { offset: 10, limit: 50 });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/sessions/test-session/events?offset=10&limit=50",
        expect.any(Object)
      );
    });
  });

  describe("authentication", () => {
    it("includes authorization header when token provided", async () => {
      const mockFetch = createMockFetch({ status: "ok" });
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        token: "test-token",
        fetch: mockFetch,
      });

      await client.getHealth();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.any(Headers),
        })
      );

      const call = mockFetch.mock.calls[0];
      const headers = call?.[1]?.headers as Headers | undefined;
      expect(headers?.get("Authorization")).toBe("Bearer test-token");
    });
  });

  describe("error handling", () => {
    it("throws SandboxDaemonError on non-ok response", async () => {
      const problem = {
        type: "error",
        title: "Not Found",
        status: 404,
        detail: "Session not found",
      };
      const mockFetch = createMockFetchError(404, problem);
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      await expect(client.getEvents("nonexistent")).rejects.toThrow(
        SandboxDaemonError
      );

      try {
        await client.getEvents("nonexistent");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxDaemonError);
        const error = e as SandboxDaemonError;
        expect(error.status).toBe(404);
        expect(error.problem?.title).toBe("Not Found");
      }
    });
  });

  describe("replyQuestion", () => {
    it("sends question reply", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 204 })
      );
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      await client.replyQuestion("test-session", "q1", {
        answers: [["Yes"]],
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/sessions/test-session/questions/q1/reply",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ answers: [["Yes"]] }),
        })
      );
    });
  });

  describe("replyPermission", () => {
    it("sends permission reply", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 204 })
      );
      const client = new SandboxDaemonClient({
        baseUrl: "http://localhost:8080",
        fetch: mockFetch,
      });

      await client.replyPermission("test-session", "p1", {
        reply: "once",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/sessions/test-session/permissions/p1/reply",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ reply: "once" }),
        })
      );
    });
  });
});
