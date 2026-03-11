import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@sandbox-agent/foundry-shared";
import { filterTasks, formatRelativeAge, fuzzyMatch, summarizeTasks } from "../src/view-model.js";

const sample: TaskRecord = {
  workspaceId: "default",
  repoId: "repo-a",
  repoRemote: "https://example.com/repo-a.git",
  taskId: "task-1",
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
      sandboxActorId: null,
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

describe("search helpers", () => {
  it("supports ordered fuzzy matching", () => {
    expect(fuzzyMatch("feature/test-branch", "ftb")).toBe(true);
    expect(fuzzyMatch("feature/test-branch", "fbt")).toBe(false);
  });

  it("filters rows across branch and title", () => {
    const rows: TaskRecord[] = [
      sample,
      {
        ...sample,
        taskId: "task-2",
        branchName: "docs/update-intro",
        title: "Docs Intro Refresh",
        status: "idle",
      },
    ];
    expect(filterTasks(rows, "doc")).toHaveLength(1);
    expect(filterTasks(rows, "h2")).toHaveLength(1);
    expect(filterTasks(rows, "test")).toHaveLength(2);
  });
});

describe("summary helpers", () => {
  it("formats relative age", () => {
    expect(formatRelativeAge(9_000, 10_000)).toBe("1s");
    expect(formatRelativeAge(0, 120_000)).toBe("2m");
  });

  it("summarizes by status and provider", () => {
    const rows: TaskRecord[] = [
      sample,
      { ...sample, taskId: "task-2", status: "idle", providerId: "daytona" },
      { ...sample, taskId: "task-3", status: "error", providerId: "daytona" },
    ];

    const summary = summarizeTasks(rows);
    expect(summary.total).toBe(3);
    expect(summary.byStatus.running).toBe(1);
    expect(summary.byStatus.idle).toBe(1);
    expect(summary.byStatus.error).toBe(1);
    expect(summary.byProvider.daytona).toBe(3);
  });
});
