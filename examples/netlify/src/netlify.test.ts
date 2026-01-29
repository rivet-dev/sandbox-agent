import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupNetlifySandboxAgent } from "./netlify.js";

describe("Netlify Sandbox Agent", () => {
  let cleanup: (() => Promise<void>) | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    if (!process.env.NETLIFY_URL && !process.env.TEST_NETLIFY_URL) {
      throw new Error("NETLIFY_URL or TEST_NETLIFY_URL required for testing");
    }

    const netlifyUrl = process.env.TEST_NETLIFY_URL || process.env.NETLIFY_URL!;
    const setup = await setupNetlifySandboxAgent(netlifyUrl);
    baseUrl = setup.baseUrl;
    cleanup = setup.cleanup;
  }, 120000); // 2 minute timeout for cold start

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  it("should connect to Netlify-hosted sandbox agent", async () => {
    expect(baseUrl).toBeTruthy();
    expect(baseUrl).toMatch(/^https?:\/\//);
  });
});