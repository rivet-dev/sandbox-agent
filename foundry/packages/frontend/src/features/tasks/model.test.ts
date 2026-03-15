import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@sandbox-agent/foundry-shared";
import { formatDiffStat, groupTasksByRepo } from "./model";

const base: TaskRecord = {
  organizationId: "default",
  repoId: "repo-a",
  repoRemote: "https://example.com/repo-a.git",
  taskId: "task-1",
  branchName: "feature/one",
  title: "Feature one",
  task: "Ship one",
  sandboxProviderId: "local",
  status: "running",
  statusMessage: null,
  activeSandboxId: "sandbox-1",
  activeSessionId: "session-1",
  sandboxes: [
    {
      sandboxId: "sandbox-1",
      sandboxProviderId: "local",
      sandboxActorId: null,
      switchTarget: "sandbox://local/sandbox-1",
      cwd: null,
      createdAt: 10,
      updatedAt: 10,
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
  createdAt: 10,
  updatedAt: 10,
};

describe("groupTasksByRepo", () => {
  it("groups by repo and sorts by recency", () => {
    const rows: TaskRecord[] = [
      { ...base, taskId: "h1", repoId: "repo-a", repoRemote: "https://example.com/repo-a.git", updatedAt: 10 },
      { ...base, taskId: "h2", repoId: "repo-a", repoRemote: "https://example.com/repo-a.git", updatedAt: 50 },
      { ...base, taskId: "h3", repoId: "repo-b", repoRemote: "https://example.com/repo-b.git", updatedAt: 30 },
    ];

    const groups = groupTasksByRepo(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.repoId).toBe("repo-a");
    expect(groups[0]?.tasks[0]?.taskId).toBe("h2");
  });

  it("sorts repo groups by latest task activity first", () => {
    const rows: TaskRecord[] = [
      { ...base, taskId: "h1", repoId: "repo-z", repoRemote: "https://example.com/repo-z.git", updatedAt: 200 },
      { ...base, taskId: "h2", repoId: "repo-a", repoRemote: "https://example.com/repo-a.git", updatedAt: 100 },
    ];

    const groups = groupTasksByRepo(rows);
    expect(groups[0]?.repoId).toBe("repo-z");
    expect(groups[1]?.repoId).toBe("repo-a");
  });
});

describe("formatDiffStat", () => {
  it("returns No changes for zero-diff values", () => {
    expect(formatDiffStat("+0/-0")).toBe("No changes");
    expect(formatDiffStat("+0 -0")).toBe("No changes");
  });

  it("returns dash for empty values", () => {
    expect(formatDiffStat(null)).toBe("-");
    expect(formatDiffStat("")).toBe("-");
  });

  it("keeps non-empty non-zero diff stats", () => {
    expect(formatDiffStat("+12/-4")).toBe("+12/-4");
  });
});
