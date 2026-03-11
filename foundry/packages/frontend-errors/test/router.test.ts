import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createFrontendErrorCollectorRouter } from "../src/router.js";
import { createFrontendErrorCollectorScript } from "../src/script.js";

describe("frontend error collector router", () => {
  test("writes accepted event payloads to NDJSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hf-frontend-errors-"));
    const logFilePath = join(directory, "events.ndjson");
    const app = createFrontendErrorCollectorRouter({ logFilePath, reporter: "test-suite" });

    try {
      const response = await app.request("/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "window-error",
          message: "Boom",
          stack: "at app.tsx:1:1",
          context: { route: "/workspaces/default" },
        }),
      });

      expect(response.status).toBe(202);

      const written = await readFile(logFilePath, "utf8");
      const [firstLine] = written.trim().split("\n");
      expect(firstLine).toBeTruthy();
      const parsed = JSON.parse(firstLine ?? "{}") as {
        kind?: string;
        message?: string;
        reporter?: string;
        context?: { route?: string };
      };
      expect(parsed.kind).toBe("window-error");
      expect(parsed.message).toBe("Boom");
      expect(parsed.reporter).toBe("test-suite");
      expect(parsed.context?.route).toBe("/workspaces/default");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("frontend error collector script", () => {
  test("embeds configured endpoint", () => {
    const script = createFrontendErrorCollectorScript({
      endpoint: "/__foundry/frontend-errors/events",
    });
    expect(script).toContain("/__foundry/frontend-errors/events");
    expect(script).toContain('window.addEventListener("error"');
  });
});
