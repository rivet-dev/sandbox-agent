import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDevelopmentEnvDefaults, loadDevelopmentEnvFiles } from "../src/config/env.js";

const ENV_KEYS = ["NODE_ENV", "APP_URL", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "GITHUB_REDIRECT_URI", "GITHUB_APP_PRIVATE_KEY"] as const;

const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

function resetEnv(): void {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original == null) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

describe("development env loading", () => {
  afterEach(() => {
    resetEnv();
  });

  test("loads .env.development only in development", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-env-"));
    writeFileSync(join(dir, ".env.development"), "APP_URL=http://localhost:4999\n", "utf8");

    process.env.NODE_ENV = "development";
    delete process.env.APP_URL;

    const loaded = loadDevelopmentEnvFiles(dir);

    expect(loaded).toHaveLength(1);
    expect(process.env.APP_URL).toBe("http://localhost:4999");
  });

  test("walks parent directories to find repo-level development env files", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-env-"));
    const nested = join(dir, "foundry", "packages", "backend");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env.development.local"), "APP_URL=http://localhost:4888\n", "utf8");

    process.env.NODE_ENV = "development";
    delete process.env.APP_URL;

    const loaded = loadDevelopmentEnvFiles(nested);

    expect(loaded).toContain(join(dir, ".env.development.local"));
    expect(process.env.APP_URL).toBe("http://localhost:4888");
  });

  test("skips dotenv files outside development", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-env-"));
    writeFileSync(join(dir, ".env.development"), "APP_URL=http://localhost:4999\n", "utf8");

    process.env.NODE_ENV = "production";
    delete process.env.APP_URL;

    const loaded = loadDevelopmentEnvFiles(dir);

    expect(loaded).toEqual([]);
    expect(process.env.APP_URL).toBeUndefined();
  });

  test("applies safe local defaults only in development", () => {
    process.env.NODE_ENV = "development";
    delete process.env.APP_URL;
    delete process.env.BETTER_AUTH_URL;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.GITHUB_REDIRECT_URI;

    applyDevelopmentEnvDefaults();

    expect(process.env.APP_URL).toBe("http://localhost:4173");
    expect(process.env.BETTER_AUTH_URL).toBe("http://localhost:4173");
    expect(process.env.BETTER_AUTH_SECRET).toBe("sandbox-agent-foundry-development-only-change-me");
    expect(process.env.GITHUB_REDIRECT_URI).toBe("http://localhost:4173/api/rivet/app/auth/github/callback");
  });

  test("decodes escaped newlines for quoted env values", () => {
    const dir = mkdtempSync(join(tmpdir(), "foundry-env-"));
    writeFileSync(join(dir, ".env.development"), 'GITHUB_APP_PRIVATE_KEY="line-1\\nline-2\\n"\n', "utf8");

    process.env.NODE_ENV = "development";
    delete process.env.GITHUB_APP_PRIVATE_KEY;

    loadDevelopmentEnvFiles(dir);

    expect(process.env.GITHUB_APP_PRIVATE_KEY).toBe("line-1\nline-2\n");
  });
});
