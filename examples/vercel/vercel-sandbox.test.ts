import { describe, it, expect } from "vitest";
import { buildHeaders } from "../shared/sandbox-agent-client.ts";
import { setupVercelSandboxAgent } from "./vercel-sandbox.ts";

const hasOidc = Boolean(process.env.VERCEL_OIDC_TOKEN);
const hasAccess = Boolean(
  process.env.VERCEL_TOKEN &&
    process.env.VERCEL_TEAM_ID &&
    process.env.VERCEL_PROJECT_ID
);
const shouldRun = hasOidc || hasAccess;
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

describe("vercel sandbox example", () => {
  testFn(
    "starts sandbox-agent and responds to /v1/health",
    async () => {
      const { baseUrl, token, cleanup } = await setupVercelSandboxAgent();
      try {
        const response = await fetch(`${baseUrl}/v1/health`, {
          headers: buildHeaders({ token }),
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
