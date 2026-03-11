import { describe, expect, it } from "vitest";
import type { HandoffRecord } from "@sandbox-agent/foundry-shared";
import { formatDiffStat, groupHandoffsByRepo } from "./model";

const base: HandoffRecord = {
  workspaceId: "default",
  repoId: "repo-a",
  repoRemote: "https://example.com/repo-a.git",
  handoffId: "handoff-1",
  branchName: "feature/one",
  title: "Feature one",
  task: "Ship one",
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

describe("groupHandoffsByRepo", () => {
  it("groups by repo and sorts by recency", () => {
    const rows: HandoffRecord[] = [
      { ...base, handoffId: "h1", repoId: "repo-a", repoRemote: "https://example.com/repo-a.git", updatedAt: 10 },
      { ...base, handoffId: "h2", repoId: "repo-a", repoRemote: "https://example.com/repo-a.git", updatedAt: 50 },
      { ...base, handoffId: "h3", repoId: "repo-b", repoRemote: "https://example.com/repo-b.git", updatedAt: 30 },
    ];

    const groups = groupHandoffsByRepo(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.repoId).toBe("repo-a");
    expect(groups[0]?.handoffs[0]?.handoffId).toBe("h2");
  });

  it("sorts repo groups by latest handoff activity first", () => {
    const rows: HandoffRecord[] = [
      { ...base, handoffId: "h1", repoId: "repo-z", repoRemote: "https://example.com/repo-z.git", updatedAt: 200 },
      { ...base, handoffId: "h2", repoId: "repo-a", repoRemote: "https://example.com/repo-a.git", updatedAt: 100 },
    ];

    const groups = groupHandoffsByRepo(rows);
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
