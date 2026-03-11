import { describe, expect, it } from "vitest";
import { shouldMarkSessionUnreadForStatus } from "../src/actors/task/workbench.js";

describe("workbench unread status transitions", () => {
  it("marks unread when a running session first becomes idle", () => {
    expect(shouldMarkSessionUnreadForStatus({ thinkingSinceMs: Date.now() - 1_000 }, "idle")).toBe(true);
  });

  it("does not re-mark unread on repeated idle polls after thinking has cleared", () => {
    expect(shouldMarkSessionUnreadForStatus({ thinkingSinceMs: null }, "idle")).toBe(false);
  });

  it("does not mark unread while the session is still running", () => {
    expect(shouldMarkSessionUnreadForStatus({ thinkingSinceMs: Date.now() - 1_000 }, "running")).toBe(false);
  });
});
