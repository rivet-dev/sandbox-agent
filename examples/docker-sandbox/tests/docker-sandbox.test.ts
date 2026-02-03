import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const shouldRun = process.env.RUN_DOCKER_SANDBOX_EXAMPLES === "1";
const timeoutMs = Number.parseInt(process.env.SANDBOX_TEST_TIMEOUT_MS || "", 10) || 300_000;

const testFn = shouldRun ? it : it.skip;

function execCapture(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).toString().trim();
}

function isDockerSandboxAvailable(): boolean {
  try {
    execCapture("docker sandbox --help");
    return true;
  } catch {
    return false;
  }
}

describe("docker-sandbox example", () => {
  testFn(
    "docker sandbox CLI is available",
    async () => {
      expect(isDockerSandboxAvailable()).toBe(true);
    },
    timeoutMs
  );

  testFn(
    "can create and remove a sandbox",
    async () => {
      if (!isDockerSandboxAvailable()) {
        console.log("Skipping: Docker Sandbox not available");
        return;
      }

      const sandboxName = `test-sandbox-${Date.now()}`;
      const workspaceDir = process.cwd();

      try {
        // Create sandbox
        execCapture(`docker sandbox create --name ${sandboxName} ${workspaceDir}`);

        // Verify it exists
        const list = execCapture(`docker sandbox ls --format "{{.Name}}"`);
        expect(list.split("\n")).toContain(sandboxName);

        // Execute a command inside
        const result = execCapture(`docker sandbox exec ${sandboxName} echo "hello"`);
        expect(result).toBe("hello");
      } finally {
        // Cleanup
        try {
          execCapture(`docker sandbox rm -f ${sandboxName}`);
        } catch {
          // Ignore cleanup errors
        }
      }
    },
    timeoutMs
  );
});
