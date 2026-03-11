import { describe, expect, it } from "vitest";
import { ConfigSchema, type AppConfig } from "@sandbox-agent/foundry-shared";
import { createProviderRegistry } from "../src/providers/index.js";

function makeConfig(): AppConfig {
  return ConfigSchema.parse({
    auto_submit: true,
    notify: ["terminal"],
    workspace: { default: "default" },
    backend: {
      host: "127.0.0.1",
      port: 7741,
      dbPath: "~/.local/share/foundry/task.db",
      opencode_poll_interval: 2,
      github_poll_interval: 30,
      backup_interval_secs: 3600,
      backup_retention_days: 7,
    },
    providers: {
      local: {},
      daytona: { image: "ubuntu:24.04" },
    },
  });
}

describe("provider registry", () => {
  it("defaults to local when daytona is not configured", () => {
    const registry = createProviderRegistry(makeConfig());
    expect(registry.defaultProviderId()).toBe("local");
  });

  it("prefers daytona when an api key is configured", () => {
    const registry = createProviderRegistry(
      ConfigSchema.parse({
        ...makeConfig(),
        providers: {
          ...makeConfig().providers,
          daytona: {
            ...makeConfig().providers.daytona,
            apiKey: "test-token",
          },
        },
      }),
    );
    expect(registry.defaultProviderId()).toBe("daytona");
  });

  it("returns the built-in provider", () => {
    const registry = createProviderRegistry(makeConfig());
    expect(registry.get("daytona").id()).toBe("daytona");
  });
});
