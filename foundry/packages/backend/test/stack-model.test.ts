import { describe, expect, it } from "vitest";
import { normalizeParentBranch, parentLookupFromStack, sortBranchesForOverview } from "../src/actors/project/stack-model.js";

describe("stack-model", () => {
  it("normalizes self-parent references to null", () => {
    expect(normalizeParentBranch("feature/a", "feature/a")).toBeNull();
    expect(normalizeParentBranch("feature/a", "main")).toBe("main");
    expect(normalizeParentBranch("feature/a", null)).toBeNull();
  });

  it("builds parent lookup with sanitized entries", () => {
    const lookup = parentLookupFromStack([
      { branchName: "feature/a", parentBranch: "main" },
      { branchName: "feature/b", parentBranch: "feature/b" },
      { branchName: " ", parentBranch: "main" },
    ]);

    expect(lookup.get("feature/a")).toBe("main");
    expect(lookup.get("feature/b")).toBeNull();
    expect(lookup.has(" ")).toBe(false);
  });

  it("orders branches by graph depth and handles cycles safely", () => {
    const rows = sortBranchesForOverview([
      { branchName: "feature/b", parentBranch: "feature/a", updatedAt: 200 },
      { branchName: "feature/a", parentBranch: "main", updatedAt: 100 },
      { branchName: "main", parentBranch: null, updatedAt: 50 },
      { branchName: "cycle-a", parentBranch: "cycle-b", updatedAt: 300 },
      { branchName: "cycle-b", parentBranch: "cycle-a", updatedAt: 250 },
    ]);

    expect(rows.map((row) => row.branchName)).toEqual(["main", "feature/a", "feature/b", "cycle-a", "cycle-b"]);
  });
});
