import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, type AppConfig } from "@sandbox-agent/foundry-shared";
import type { BackendDriver } from "../../src/driver.js";
import { initActorRuntimeContext } from "../../src/actors/context.js";
import { createProviderRegistry } from "../../src/providers/index.js";
import { createDefaultAppShellServices } from "../../src/services/app-shell-runtime.js";

export function createTestConfig(overrides?: Partial<AppConfig>): AppConfig {
  return ConfigSchema.parse({
    auto_submit: true,
    notify: ["terminal" as const],
    workspace: { default: "default" },
    backend: {
      host: "127.0.0.1",
      port: 7741,
      dbPath: join(tmpdir(), `hf-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`),
      opencode_poll_interval: 2,
      github_poll_interval: 30,
      backup_interval_secs: 3600,
      backup_retention_days: 7,
    },
    providers: {
      daytona: { image: "ubuntu:24.04" },
    },
    ...overrides,
  });
}

export function createTestRuntimeContext(driver: BackendDriver, configOverrides?: Partial<AppConfig>): { config: AppConfig } {
  const config = createTestConfig(configOverrides);
  const providers = createProviderRegistry(config, driver);
  initActorRuntimeContext(config, providers, undefined, driver, createDefaultAppShellServices());
  return { config };
}
