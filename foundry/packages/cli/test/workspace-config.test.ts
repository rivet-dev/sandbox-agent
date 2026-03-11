import { describe, expect, it } from "vitest";
import { ConfigSchema } from "@sandbox-agent/foundry-shared";
import { resolveWorkspace } from "../src/workspace/config.js";

describe("cli workspace resolution", () => {
  it("uses default workspace when no flag", () => {
    const config = ConfigSchema.parse({
      auto_submit: true as const,
      notify: ["terminal" as const],
      workspace: { default: "team" },
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
        daytona: { image: "ubuntu:24.04" },
      },
    });

    expect(resolveWorkspace(undefined, config)).toBe("team");
    expect(resolveWorkspace("alpha", config)).toBe("alpha");
  });
});
