import { describe, it, expect, vi, type Mock } from "vitest";
import { SandboxDaemonClient } from "../src/client.ts";
import type { UniversalEvent } from "../src/types.ts";

function createMockResponse(chunks: string[]): Response {
  let chunkIndex = 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(encoder.encode(chunks[chunkIndex]));
        chunkIndex++;
      } else {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function createMockFetch(chunks: string[]): Mock<typeof fetch> {
  return vi.fn<typeof fetch>().mockResolvedValue(createMockResponse(chunks));
}

function createEvent(sequence: number): UniversalEvent {
  return {
    event_id: `evt-${sequence}`,
    sequence,
    session_id: "test-session",
    source: "agent",
    synthetic: false,
    time: new Date().toISOString(),
    type: "item.started",
    data: {
      item_id: `item-${sequence}`,
      kind: "message",
      role: "assistant",
      status: "in_progress",
      content: [],
    },
  } as UniversalEvent;
}

describe("SSE Parser", () => {
  it("parses single SSE event", async () => {
    const event = createEvent(1);
    const mockFetch = createMockFetch([`data: ${JSON.stringify(event)}\n\n`]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    const events: UniversalEvent[] = [];
    for await (const e of client.streamEvents("test-session")) {
      events.push(e);
    }

    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(1);
  });

  it("parses multiple SSE events", async () => {
    const event1 = createEvent(1);
    const event2 = createEvent(2);
    const mockFetch = createMockFetch([
      `data: ${JSON.stringify(event1)}\n\n`,
      `data: ${JSON.stringify(event2)}\n\n`,
    ]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    const events: UniversalEvent[] = [];
    for await (const e of client.streamEvents("test-session")) {
      events.push(e);
    }

    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  it("handles chunked SSE data", async () => {
    const event = createEvent(1);
    const fullMessage = `data: ${JSON.stringify(event)}\n\n`;
    // Split in the middle of the message
    const mockFetch = createMockFetch([
      fullMessage.slice(0, 10),
      fullMessage.slice(10),
    ]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    const events: UniversalEvent[] = [];
    for await (const e of client.streamEvents("test-session")) {
      events.push(e);
    }

    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(1);
  });

  it("handles multiple events in single chunk", async () => {
    const event1 = createEvent(1);
    const event2 = createEvent(2);
    const mockFetch = createMockFetch([
      `data: ${JSON.stringify(event1)}\n\ndata: ${JSON.stringify(event2)}\n\n`,
    ]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    const events: UniversalEvent[] = [];
    for await (const e of client.streamEvents("test-session")) {
      events.push(e);
    }

    expect(events).toHaveLength(2);
  });

  it("ignores non-data lines", async () => {
    const event = createEvent(1);
    const mockFetch = createMockFetch([
      `: this is a comment\n`,
      `id: 1\n`,
      `data: ${JSON.stringify(event)}\n\n`,
    ]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    const events: UniversalEvent[] = [];
    for await (const e of client.streamEvents("test-session")) {
      events.push(e);
    }

    expect(events).toHaveLength(1);
  });

  it("handles CRLF line endings", async () => {
    const event = createEvent(1);
    const mockFetch = createMockFetch([
      `data: ${JSON.stringify(event)}\r\n\r\n`,
    ]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    const events: UniversalEvent[] = [];
    for await (const e of client.streamEvents("test-session")) {
      events.push(e);
    }

    expect(events).toHaveLength(1);
  });

  it("handles empty stream", async () => {
    const mockFetch = createMockFetch([]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    const events: UniversalEvent[] = [];
    for await (const e of client.streamEvents("test-session")) {
      events.push(e);
    }

    expect(events).toHaveLength(0);
  });

  it("passes query parameters", async () => {
    const mockFetch = createMockFetch([]);

    const client = new SandboxDaemonClient({
      baseUrl: "http://localhost:8080",
      fetch: mockFetch,
    });

    // Consume the stream
    for await (const _ of client.streamEvents("test-session", { offset: 5 })) {
      // empty
    }

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("offset=5"),
      expect.any(Object)
    );
  });
});
