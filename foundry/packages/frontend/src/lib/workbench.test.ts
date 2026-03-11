import { describe, expect, it } from "vitest";
import type { TaskWorkbenchSnapshot } from "@sandbox-agent/foundry-shared";
import { resolveRepoRouteTaskId } from "./workbench-routing";

const snapshot: TaskWorkbenchSnapshot = {
  workspaceId: "default",
  repos: [
    { id: "repo-a", label: "acme/repo-a" },
    { id: "repo-b", label: "acme/repo-b" },
  ],
  repoSections: [],
  tasks: [
    {
      id: "task-a",
      repoId: "repo-a",
      title: "Alpha",
      status: "idle",
      repoName: "acme/repo-a",
      updatedAtMs: 20,
      branch: "feature/alpha",
      pullRequest: null,
      tabs: [],
      fileChanges: [],
      diffs: {},
      fileTree: [],
    },
  ],
};

describe("resolveRepoRouteTaskId", () => {
  it("finds the active task for a repo route", () => {
    expect(resolveRepoRouteTaskId(snapshot, "repo-a")).toBe("task-a");
  });

  it("returns null when a repo has no task yet", () => {
    expect(resolveRepoRouteTaskId(snapshot, "repo-b")).toBeNull();
  });
});
