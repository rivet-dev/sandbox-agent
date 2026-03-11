import { describe, expect, it } from "vitest";
import type { DaytonaClientLike, DaytonaDriver } from "../src/driver.js";
import type { DaytonaCreateSandboxOptions } from "../src/integrations/daytona/client.js";
import { DaytonaProvider } from "../src/providers/daytona/index.js";

class RecordingDaytonaClient implements DaytonaClientLike {
  createSandboxCalls: DaytonaCreateSandboxOptions[] = [];
  executedCommands: string[] = [];

  async createSandbox(options: DaytonaCreateSandboxOptions) {
    this.createSandboxCalls.push(options);
    return {
      id: "sandbox-1",
      state: "started",
      snapshot: "snapshot-foundry",
      labels: {},
    };
  }

  async getSandbox(sandboxId: string) {
    return {
      id: sandboxId,
      state: "started",
      snapshot: "snapshot-foundry",
      labels: {},
    };
  }

  async startSandbox(_sandboxId: string, _timeoutSeconds?: number) {}

  async stopSandbox(_sandboxId: string, _timeoutSeconds?: number) {}

  async deleteSandbox(_sandboxId: string) {}

  async executeCommand(_sandboxId: string, command: string) {
    this.executedCommands.push(command);
    return { exitCode: 0, result: "" };
  }

  async getPreviewEndpoint(sandboxId: string, port: number) {
    return {
      url: `https://preview.example/sandbox/${sandboxId}/port/${port}`,
      token: "preview-token",
    };
  }
}

function createProviderWithClient(client: DaytonaClientLike): DaytonaProvider {
  const daytonaDriver: DaytonaDriver = {
    createClient: () => client,
  };

  return new DaytonaProvider(
    {
      apiKey: "test-key",
      image: "ubuntu:24.04",
    },
    daytonaDriver,
  );
}

describe("daytona provider snapshot image behavior", () => {
  it("creates sandboxes using a snapshot-capable image recipe", async () => {
    const client = new RecordingDaytonaClient();
    const provider = createProviderWithClient(client);

    const handle = await provider.createSandbox({
      workspaceId: "default",
      repoId: "repo-1",
      repoRemote: "https://github.com/acme/repo.git",
      branchName: "feature/test",
      taskId: "task-1",
    });

    expect(client.createSandboxCalls).toHaveLength(1);
    const createCall = client.createSandboxCalls[0];
    if (!createCall) {
      throw new Error("expected create sandbox call");
    }

    expect(typeof createCall.image).not.toBe("string");
    if (typeof createCall.image === "string") {
      throw new Error("expected daytona image recipe object");
    }

    const dockerfile = createCall.image.dockerfile;
    expect(dockerfile).toContain("apt-get install -y curl ca-certificates git openssh-client nodejs npm");
    expect(dockerfile).toContain("sandbox-agent/0.3.0/install.sh");
    const installAgentLines = dockerfile.match(/sandbox-agent install-agent [a-z0-9-]+/gi) ?? [];
    expect(installAgentLines.length).toBeGreaterThanOrEqual(2);
    const commands = client.executedCommands.join("\n");
    expect(commands).toContain("GIT_TERMINAL_PROMPT=0");
    expect(commands).toContain("GIT_ASKPASS=/bin/echo");

    expect(handle.metadata.snapshot).toBe("snapshot-foundry");
    expect(handle.metadata.image).toBe("ubuntu:24.04");
    expect(handle.metadata.cwd).toBe("/home/daytona/foundry/default/repo-1/task-1/repo");
    expect(client.executedCommands.length).toBeGreaterThan(0);
  });

  it("starts sandbox-agent with ACP timeout env override", async () => {
    const previous = process.env.HF_SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS;
    process.env.HF_SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS = "240000";

    try {
      const client = new RecordingDaytonaClient();
      const provider = createProviderWithClient(client);

      await provider.ensureSandboxAgent({
        workspaceId: "default",
        sandboxId: "sandbox-1",
      });

      const startCommand = client.executedCommands.find((command) =>
        command.includes("nohup env SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=240000 sandbox-agent server"),
      );

      const joined = client.executedCommands.join("\n");
      expect(joined).toContain("sandbox-agent/0.3.0/install.sh");
      expect(joined).toContain("SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=240000");
      expect(joined).toContain("apt-get install -y nodejs npm");
      expect(joined).toContain("sandbox-agent server --no-token --host 0.0.0.0 --port 2468");
      expect(startCommand).toBeTruthy();
    } finally {
      if (previous === undefined) {
        delete process.env.HF_SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS;
      } else {
        process.env.HF_SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS = previous;
      }
    }
  });

  it("fails with explicit timeout when daytona createSandbox hangs", async () => {
    const previous = process.env.HF_DAYTONA_REQUEST_TIMEOUT_MS;
    process.env.HF_DAYTONA_REQUEST_TIMEOUT_MS = "120";

    const hangingClient: DaytonaClientLike = {
      createSandbox: async () => await new Promise(() => {}),
      getSandbox: async (sandboxId) => ({ id: sandboxId, state: "started" }),
      startSandbox: async () => {},
      stopSandbox: async () => {},
      deleteSandbox: async () => {},
      executeCommand: async () => ({ exitCode: 0, result: "" }),
      getPreviewEndpoint: async (sandboxId, port) => ({
        url: `https://preview.example/sandbox/${sandboxId}/port/${port}`,
        token: "preview-token",
      }),
    };

    try {
      const provider = createProviderWithClient(hangingClient);
      await expect(
        provider.createSandbox({
          workspaceId: "default",
          repoId: "repo-1",
          repoRemote: "https://github.com/acme/repo.git",
          branchName: "feature/test",
          taskId: "task-timeout",
        }),
      ).rejects.toThrow("daytona create sandbox timed out after 120ms");
    } finally {
      if (previous === undefined) {
        delete process.env.HF_DAYTONA_REQUEST_TIMEOUT_MS;
      } else {
        process.env.HF_DAYTONA_REQUEST_TIMEOUT_MS = previous;
      }
    }
  });

  it("executes backend-managed sandbox commands through provider API", async () => {
    const client = new RecordingDaytonaClient();
    const provider = createProviderWithClient(client);

    const result = await provider.executeCommand({
      workspaceId: "default",
      sandboxId: "sandbox-1",
      command: "echo backend-push",
      label: "manual push",
    });

    expect(result.exitCode).toBe(0);
    expect(client.executedCommands).toContain("echo backend-push");
  });
});
