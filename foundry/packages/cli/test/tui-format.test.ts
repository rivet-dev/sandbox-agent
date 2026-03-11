import { describe, expect, it } from "vitest";
import type { HandoffRecord } from "@sandbox-agent/foundry-shared";
import { filterHandoffs, fuzzyMatch } from "@sandbox-agent/foundry-client";
import { formatRows } from "../src/tui.js";

const sample: HandoffRecord = {
  workspaceId: "default",
  repoId: "repo-a",
  repoRemote: "https://example.com/repo-a.git",
  handoffId: "handoff-1",
  branchName: "feature/test",
  title: "Test Title",
  task: "Do test",
  providerId: "daytona",
  status: "running",
  statusMessage: null,
  activeSandboxId: "sandbox-1",
  activeSessionId: "session-1",
  sandboxes: [
    {
      sandboxId: "sandbox-1",
      providerId: "daytona",
      switchTarget: "daytona://sandbox-1",
      cwd: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  agentType: null,
  prSubmitted: false,
  diffStat: null,
  prUrl: null,
  prAuthor: null,
  ciStatus: null,
  reviewStatus: null,
  reviewer: null,
  conflictsWithMain: null,
  hasUnpushed: null,
  parentBranch: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("formatRows", () => {
  it("renders rust-style table header and empty state", () => {
    const output = formatRows([], 0, "default", "ok");
    expect(output).toContain("Branch/PR (type to filter)");
    expect(output).toContain("No branches found.");
    expect(output).toContain("Ctrl-H:cheatsheet");
    expect(output).toContain("ok");
  });

  it("marks selected row with highlight", () => {
    const output = formatRows([sample], 0, "default", "ready");
    expect(output).toContain("┃ ");
    expect(output).toContain("Test Title");
    expect(output).toContain("Ctrl-H:cheatsheet");
  });

  it("pins footer to the last terminal row", () => {
    const output = formatRows([sample], 0, "default", "ready", "", false, {
      width: 80,
      height: 12,
    });
    const lines = output.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines[11]).toContain("Ctrl-H:cheatsheet");
    expect(lines[11]).toContain("v");
  });
});

describe("search", () => {
  it("supports ordered fuzzy matching", () => {
    expect(fuzzyMatch("feature/test-branch", "ftb")).toBe(true);
    expect(fuzzyMatch("feature/test-branch", "fbt")).toBe(false);
  });

  it("filters rows across branch and title", () => {
    const rows: HandoffRecord[] = [
      sample,
      {
        ...sample,
        handoffId: "handoff-2",
        branchName: "docs/update-intro",
        title: "Docs Intro Refresh",
        status: "idle",
      },
    ];
    expect(filterHandoffs(rows, "doc")).toHaveLength(1);
    expect(filterHandoffs(rows, "h2")).toHaveLength(1);
    expect(filterHandoffs(rows, "test")).toHaveLength(2);
  });
});
