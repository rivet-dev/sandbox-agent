import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { validateRemote } from "../src/integrations/git/index.js";

const execFileAsync = promisify(execFile);

describe("validateRemote", () => {
  const originalCwd = process.cwd();

  beforeEach(() => {
    process.chdir(originalCwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  test("ignores broken worktree gitdir in current directory", async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), "validate-remote-cwd-"));
    const brokenRepoDir = resolve(sandboxDir, "broken-worktree");
    const remoteRepoDir = resolve(sandboxDir, "remote");

    mkdirSync(brokenRepoDir, { recursive: true });
    writeFileSync(resolve(brokenRepoDir, ".git"), "gitdir: /definitely/missing/worktree\n", "utf8");
    await execFileAsync("git", ["init", remoteRepoDir]);
    await execFileAsync("git", ["-C", remoteRepoDir, "config", "user.name", "Foundry Test"]);
    await execFileAsync("git", ["-C", remoteRepoDir, "config", "user.email", "test@example.com"]);
    writeFileSync(resolve(remoteRepoDir, "README.md"), "# test\n", "utf8");
    await execFileAsync("git", ["-C", remoteRepoDir, "add", "README.md"]);
    await execFileAsync("git", ["-C", remoteRepoDir, "commit", "-m", "init"]);

    process.chdir(brokenRepoDir);

    await expect(validateRemote(remoteRepoDir)).resolves.toBeUndefined();
  });
});
