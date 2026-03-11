import { describe, expect, it } from "vitest";
import { deriveFallbackTitle, resolveCreateFlowDecision, sanitizeBranchName } from "../src/services/create-flow.js";

describe("create flow decision", () => {
  it("derives a conventional-style fallback title from task text", () => {
    const title = deriveFallbackTitle("Fix OAuth callback bug in handler");
    expect(title).toBe("fix: Fix OAuth callback bug in handler");
  });

  it("preserves an explicit conventional prefix without duplicating it", () => {
    const title = deriveFallbackTitle("Reply with exactly: READY", "feat: Browser UI Flow");
    expect(title).toBe("feat: Browser UI Flow");
  });

  it("sanitizes generated branch names", () => {
    expect(sanitizeBranchName("feat: Add @mentions & #hashtags")).toBe("feat-add-mentions-hashtags");
    expect(sanitizeBranchName("  spaces  everywhere  ")).toBe("spaces-everywhere");
  });

  it("auto-increments generated branch names for conflicts", () => {
    const resolved = resolveCreateFlowDecision({
      task: "Add auth",
      localBranches: ["feat-add-auth"],
      handoffBranches: ["feat-add-auth-2"],
    });

    expect(resolved.title).toBe("feat: Add auth");
    expect(resolved.branchName).toBe("feat-add-auth-3");
  });

  it("fails when explicit branch already exists", () => {
    expect(() =>
      resolveCreateFlowDecision({
        task: "new task",
        explicitBranchName: "existing-branch",
        localBranches: ["existing-branch"],
        handoffBranches: [],
      }),
    ).toThrow("already exists");
  });
});
