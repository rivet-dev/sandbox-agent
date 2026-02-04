import { describe, it, expect } from "vitest";
import { buildHeaders } from "@sandbox-agent/example-shared";
import { setupComputeSdkSandboxAgent } from "../src/computesdk.ts";

const hasModal = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);
const hasVercel = Boolean(process.env.VERCEL_TOKEN || process.env.VERCEL_OIDC_TOKEN);
const hasProviderKey = Boolean(
  process.env.BLAXEL_API_KEY ||
    process.env.CSB_API_KEY ||
    process.env.DAYTONA_API_KEY ||
    process.env.E2B_API_KEY ||
    hasModal ||
    hasVercel
);

const shouldRun = Boolean(process.env.COMPUTESDK_API_KEY) && hasProviderKey;
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("computesdk example", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const { baseUrl, cleanup } = await setupComputeSdkSandboxAgent();
      try {
        const response = await fetch(`${baseUrl}/v1/health`, {
          headers: buildHeaders({}),
        });
        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.status).toBe("ok");
      } finally {
        await cleanup();
      }
    },
    timeoutMs
  );
});
