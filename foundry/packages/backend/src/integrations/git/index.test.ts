import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ensureCloned, validateRemote } from "./index.js";

const execFileAsync = promisify(execFile);
const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const path of cleanupPaths) {
    rmSync(path, { force: true, recursive: true });
  }
  cleanupPaths.clear();
});

describe("mock github remotes", () => {
  it("validates and clones onboarding repos through a local bare mirror", async () => {
    const suffix = randomUUID().slice(0, 8);
    const remoteUrl = `mockgithub://vitest-${suffix}/demo-repo`;
    const clonePath = join(tmpdir(), `foundry-clone-${suffix}`);
    const barePath = resolve(homedir(), ".local", "share", "sandbox-agent-foundry", "mock-remotes", `vitest-${suffix}`, "demo-repo.git");

    cleanupPaths.add(clonePath);
    cleanupPaths.add(resolve(homedir(), ".local", "share", "sandbox-agent-foundry", "mock-remotes", `vitest-${suffix}`));

    await validateRemote(remoteUrl);
    await ensureCloned(remoteUrl, clonePath);

    const { stdout: originStdout } = await execFileAsync("git", ["-C", clonePath, "remote", "get-url", "origin"]);
    expect(originStdout.trim()).toContain(barePath);

    const { stdout: branchStdout } = await execFileAsync("git", ["-C", clonePath, "branch", "--show-current"]);
    expect(branchStdout.trim()).toBe("main");

    const { stdout: readmeStdout } = await execFileAsync("git", ["-C", clonePath, "show", "HEAD:README.md"]);
    expect(readmeStdout).toContain(`vitest-${suffix}/demo-repo`);
  });
});
