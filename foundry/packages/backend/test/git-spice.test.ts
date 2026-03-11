import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitSpiceAvailable, gitSpiceListStack, gitSpiceRestackSubtree } from "../src/integrations/git-spice/index.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeScript(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

async function withEnv<T>(updates: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(updates)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("git-spice integration", () => {
  it("parses stack rows from mixed/malformed json output", async () => {
    const repoPath = makeTempDir("hf-git-spice-parse-");
    const scriptPath = join(repoPath, "fake-git-spice.sh");
    writeScript(
      scriptPath,
      [
        "#!/bin/sh",
        'if [ \"$1\" = \"--help\" ]; then',
        "  exit 0",
        "fi",
        'if [ \"$1\" = \"log\" ]; then',
        "  echo 'noise line'",
        '  echo \'{"branch":"feature/a","parent":"main"}\'',
        "  echo '{bad json'",
        '  echo \'{"name":"feature/b","parentBranch":"feature/a"}\'',
        '  echo \'{"name":"feature/a","parent":"main"}\'',
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );

    await withEnv({ HF_GIT_SPICE_BIN: scriptPath }, async () => {
      const rows = await gitSpiceListStack(repoPath);
      expect(rows).toEqual([
        { branchName: "feature/a", parentBranch: "main" },
        { branchName: "feature/b", parentBranch: "feature/a" },
      ]);
    });
  });

  it("falls back across versioned subtree restack command variants", async () => {
    const repoPath = makeTempDir("hf-git-spice-fallback-");
    const scriptPath = join(repoPath, "fake-git-spice.sh");
    const logPath = join(repoPath, "calls.log");
    writeScript(
      scriptPath,
      [
        "#!/bin/sh",
        'echo \"$*\" >> \"$SPICE_LOG_PATH\"',
        'if [ \"$1\" = \"--help\" ]; then',
        "  exit 0",
        "fi",
        'if [ \"$1\" = \"upstack\" ] && [ \"$2\" = \"restack\" ]; then',
        "  exit 1",
        "fi",
        'if [ \"$1\" = \"branch\" ] && [ \"$2\" = \"restack\" ] && [ \"$5\" = \"--no-prompt\" ]; then',
        "  exit 0",
        "fi",
        "exit 1",
      ].join("\n"),
    );

    await withEnv(
      {
        HF_GIT_SPICE_BIN: scriptPath,
        SPICE_LOG_PATH: logPath,
      },
      async () => {
        await gitSpiceRestackSubtree(repoPath, "feature/a");
      },
    );

    const lines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);

    expect(lines).toContain("upstack restack --branch feature/a --no-prompt");
    expect(lines).toContain("upstack restack --branch feature/a");
    expect(lines).toContain("branch restack --branch feature/a --no-prompt");
    expect(lines).not.toContain("branch restack --branch feature/a");
  });

  it("reports unavailable when explicit binary and PATH are missing", async () => {
    const repoPath = makeTempDir("hf-git-spice-missing-");

    await withEnv(
      {
        HF_GIT_SPICE_BIN: "/non-existent/hf-git-spice-binary",
        PATH: "/non-existent/bin",
      },
      async () => {
        const available = await gitSpiceAvailable(repoPath);
        expect(available).toBe(false);
      },
    );
  });
});
